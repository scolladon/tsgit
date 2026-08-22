/**
 * Loose-first-then-packed ref lookup with mtime-based packed-refs cache invalidation.
 */
import { TsgitError, unsupportedOperation } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { invalidReflogEntry } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { parseReflog, serializeReflogLine } from '../../domain/reflog/reflog-format.js';
import {
  type ReftableCheck,
  refChainTooDeep,
  refNotFound,
  refUpdateConflict,
} from '../../domain/refs/error.js';
import {
  isPerWorktreeRef,
  type PackedRefEntry,
  parseLooseRef,
  parsePackedRefs,
  serializeDirectRef,
  serializePackedRefs,
  serializeSymbolicRef,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteRef } from './atomic-write.js';
import { errorDataCode } from './internal/error-data-code.js';
import {
  commonGitDir,
  logsDir,
  looseObjectPath,
  looseRefPath,
  packedRefsPath,
  perWorktreeRefDir,
  reflogPath,
} from './path-layout.js';
import { readObject } from './read-object.js';
import { recordRefUpdate } from './record-ref-update.js';
import { createReftableRefStore } from './reftable-ref-store.js';
import { MAX_PEEL_DEPTH, MAX_REFLOG_BYTES } from './types.js';
import { exceedsMaxPeelDepth } from './validators.js';

const TEXT_ENCODER = new TextEncoder();

export interface RefStore {
  /**
   * Resolve a ref name to its direct ObjectId target, without following symbolic refs.
   * Returns undefined if the ref doesn't exist in either loose or packed storage.
   * Throws if the loose file content is a symbolic ref (callers must handle).
   */
  resolveDirect(name: RefName): Promise<ResolveDirectResult>;
  /**
   * Apply every update in `updates`, in order, as one call. Each `set` /
   * `setSymbolic` writes atomically through the ref lock; each `delete`
   * removes the ref and tombstones its reflog; each carried `reflog` (or a
   * bare `reflogOnly` entry) appends through the same gate `recordRefUpdate`
   * applies. The single call is what lets a coupled write (e.g. a branch tip
   * plus the symbolic HEAD's reflog entry) land together instead of as two
   * separately-observable mutations.
   */
  applyRefUpdates(updates: readonly RefUpdate[]): Promise<void>;
  /**
   * Every ref this backend knows, merged across the per-worktree and common
   * scopes, deduplicated, sorted by name. An optional `prefix` restricts the
   * result to names starting with it (e.g. `refs/heads/`). A loose ref whose
   * content fails to parse is silently excluded — {@link verifyIntegrity}
   * reports it instead.
   */
  listRefs(prefix?: RefName): Promise<readonly RefEntry[]>;
  /**
   * Backend-owned ref-content health. The files backend reports loose refs
   * whose body is neither a well-formed OID nor a `ref: <target>` line
   * (`badRefContent`), and well-formed loose OIDs with no LOOSE object
   * backing them (`badRefOid`) — a cheap local-store probe, not a
   * pack-aware reachability audit. The reftable backend has no raw per-ref
   * text to run that grammar check against, so `badRefContent` never
   * appears there; it instead reports one `badReftableTable` finding per
   * table that fails a structural check, naming the table and the check.
   * Independent of any external reachability scope.
   */
  verifyIntegrity(): Promise<readonly RefIntegrityFinding[]>;
  /** `name`'s reflog, oldest-first. Empty when the ref has no reflog. */
  readReflog(name: RefName): Promise<readonly ReflogEntry[]>;
  /** Every ref this backend has a reflog for, merged across scopes. */
  listReflogs(): Promise<readonly RefName[]>;
  /**
   * Pack every ref into the backend's most-compact on-disk form, and
   * remove whatever the packing makes redundant. Mirrors git's
   * `pack-refs --all` — every ref is always in scope; there is no
   * bare/tags-only mode, because the reftable backend's whole-stack
   * compaction has no per-namespace equivalent to express one.
   *
   * Files: rewrites `packed-refs` from every current packable ref (loose ∪
   * already-packed) and deletes the loose files that now duplicate it.
   * Reftable: compacts the whole stack into one table (tombstones elided)
   * and unlinks orphaned `*.ref` / `*.temp` files the resulting
   * `tables.list` no longer names.
   */
  packRefs(): Promise<PackRefsOutcome>;
}

/** Backend-neutral counts {@link RefStore.packRefs} reports. Never a table
 *  count or any other internal compaction detail — auto-compaction's own
 *  metric can legitimately differ, byte for byte, between two equally
 *  correct implementations. */
export interface PackRefsOutcome {
  readonly packedRefCount: number;
  readonly prunedLooseRefCount: number;
  readonly removedOrphanCount: number;
}

export type ResolveDirectResult =
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'missing' };

export interface RefEntry {
  readonly name: RefName;
  readonly value: ResolveDirectResult;
}

export type RefIntegrityFinding =
  | { readonly ref: RefName; readonly msgId: 'badRefContent' }
  | { readonly ref: RefName; readonly msgId: 'badRefOid'; readonly target: ObjectId }
  | {
      readonly table: string;
      readonly msgId: 'badReftableTable';
      readonly check: ReftableCheck;
    };

/**
 * A reflog entry to append, carrying what `recordRefUpdate` needs.
 * `unconditional` skips the usual "does this ref already log" gate — the
 * flag `refs/stash` needs, because git always logs the stash even though it
 * sits outside the default-loggable prefix set.
 */
export interface ReflogAppend {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly message: string;
  readonly unconditional?: boolean;
}

/**
 * One ref mutation to apply through {@link RefStore.applyRefUpdates}. `expected`
 * is the CAS guard (an `ObjectId` the ref must currently hold, or `'absent'`
 * for "must not exist"); a mismatch throws `REF_UPDATE_CONFLICT`. `reflog`
 * appends through the same `recordRefUpdate` gate a direct call would —
 * `reflogOnly` is the shape for a log entry with no accompanying ref write
 * (e.g. the coupled-HEAD entry a branch update also produces). `reflogReplace`
 * is the files backend's only way to express dropping/filtering existing
 * entries (`reflog delete`/`expire`, stash drop); the reftable backend must
 * decompose it into one log tombstone per REMOVED entry, each carrying that
 * entry's own `update_index`, not the new one.
 */
export type RefUpdate =
  | {
      readonly kind: 'set';
      readonly name: RefName;
      readonly id: ObjectId;
      readonly expected?: ObjectId | 'absent';
      readonly reflog?: ReflogAppend;
    }
  | {
      readonly kind: 'setSymbolic';
      readonly name: RefName;
      readonly target: RefName;
      readonly expected?: ObjectId | 'absent';
      readonly reflog?: ReflogAppend;
    }
  | {
      readonly kind: 'delete';
      readonly name: RefName;
      readonly expected?: ObjectId | 'absent';
    }
  | {
      readonly kind: 'reflogOnly';
      readonly name: RefName;
      readonly reflog: ReflogAppend;
    }
  | {
      readonly kind: 'reflogReplace';
      readonly name: RefName;
      readonly entries: readonly ReflogEntry[];
    };

/**
 * Per-Context store cache. Mirrors the registryCache pattern in read-object —
 * a session that resolves N refs reuses one parsed packed-refs (with mtime-keyed
 * invalidation inside the closure) instead of re-parsing on every call.
 */
const storeCache = new WeakMap<Context, RefStore>();

export function getRefStore(ctx: Context): RefStore {
  let store = storeCache.get(ctx);
  if (store === undefined) {
    store = createRefStore(ctx);
    storeCache.set(ctx, store);
  }
  return store;
}

/** Whether `name` exists in either loose or packed storage — the one seam every existence-probe caller shares. */
export async function refExists(ctx: Context, name: RefName): Promise<boolean> {
  return (await getRefStore(ctx).resolveDirect(name)).kind !== 'missing';
}

/**
 * Refuse a rename whose source is a packed-only tracking ref — moving it
 * would require a packed-refs rewrite the files backend doesn't perform. A
 * files-backend limitation (reftable has no packed refs and deletes by
 * tombstone), not a seam-level fact, so it lives here rather than on the
 * `RefStore` interface itself. A no-op when `name` is loose (or absent
 * entirely — the caller's own existence check handles that case).
 */
export async function assertRenamableTrackingRef(ctx: Context, name: RefName): Promise<void> {
  const path = looseRefPath(perWorktreeRefDir(ctx, name), name);
  if (await ctx.fs.exists(path)) return;
  const resolved = await getRefStore(ctx).resolveDirect(name);
  if (resolved.kind === 'direct') {
    throw unsupportedOperation(
      'rename-packed-tracking-ref',
      `cannot rename packed-only ref ${name} — run \`git pack-refs --unpack\` and retry`,
    );
  }
}

const HEAD_NAME: RefName = 'HEAD' as RefName;
const REFS_DIR = 'refs';
const SYMBOLIC_PREFIX = 'ref: ';
/** Matches valid SHA-1 (40-hex) or SHA-256 (64-hex) loose-ref content. */
const LOOSE_OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function isFileNotFound(err: unknown): boolean {
  return errorDataCode(err) === 'FILE_NOT_FOUND';
}

/** Byte-wise total order over ref names, matching git's own ref ordering (never `localeCompare`). */
const byName = (a: RefEntry, b: RefEntry): number => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

/** Backend dispatcher: `ctx.layout.refStorage` picks the files or reftable
 *  implementation. `getRefStore`'s `Context`-keyed memo (below) is what
 *  keeps this a one-shot decision per Context. */
export function createRefStore(ctx: Context): RefStore {
  return ctx.layout.refStorage === 'reftable'
    ? createReftableRefStore(ctx)
    : createFilesRefStore(ctx);
}

/** `loadPackedRefs`'s own return shape: the parsed entries (for a full scan —
 *  `collectCandidateNames`'s enumeration has no name to index by) alongside
 *  a name-indexed `Map` of the SAME entries, so a point lookup never falls
 *  back to a linear scan over every packed ref. Always internally
 *  consistent — never a stale `Map` alongside fresh `entries` or vice versa,
 *  including the "packed-refs file is absent" fast path, which returns a
 *  freshly empty pair rather than whatever the mtime+size cache still holds
 *  from before the file was removed. */
interface LoadedPackedRefs {
  readonly entries: readonly PackedRefEntry[];
  readonly byName: ReadonlyMap<RefName, PackedRefEntry>;
}

const EMPTY_PACKED_REFS: LoadedPackedRefs = { entries: [], byName: new Map() };

function createFilesRefStore(ctx: Context): RefStore {
  let packedCache: { readonly loaded: LoadedPackedRefs; readonly mtimeKey: string } | undefined;

  const refDir = (name: RefName): string => perWorktreeRefDir(ctx, name);

  async function loadPackedRefs(): Promise<LoadedPackedRefs> {
    const path = packedRefsPath(commonGitDir(ctx));
    if (!(await ctx.fs.exists(path))) {
      return EMPTY_PACKED_REFS;
    }
    const stat = await ctx.fs.stat(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (packedCache !== undefined && packedCache.mtimeKey === key) {
      return packedCache.loaded;
    }
    const content = await ctx.fs.readUtf8(path);
    const { entries } = parsePackedRefs(content);
    const byName = new Map(entries.map((entry) => [entry.name, entry] as const));
    const loaded: LoadedPackedRefs = { entries, byName };
    packedCache = { loaded, mtimeKey: key };
    return loaded;
  }

  async function readLooseContent(name: RefName): Promise<string | undefined> {
    const path = looseRefPath(refDir(name), name);
    try {
      return await ctx.fs.readUtf8(path);
    } catch (err) {
      if (isFileNotFound(err)) return undefined;
      throw err;
    }
  }

  async function resolveDirect(name: RefName): Promise<ResolveDirectResult> {
    const looseContent = await readLooseContent(name);
    if (looseContent !== undefined) {
      const parsed = parseLooseRef(looseContent);
      if (parsed.type === 'symbolic') {
        return { kind: 'symbolic', target: parsed.target };
      }
      return { kind: 'direct', id: parsed.target };
    }
    const packed = await loadPackedRefs();
    const entry = packed.byName.get(name);
    return entry === undefined ? { kind: 'missing' } : { kind: 'direct', id: entry.id };
  }

  /** Recursively walk one `refs/**` root, composing slash-joined ref names as it descends. */
  async function walkRefDir(dir: string, prefix: string): Promise<ReadonlyArray<RefName>> {
    const entries = await ctx.fs.readdir(dir);
    const names: RefName[] = [];
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        for (const name of await walkRefDir(`${dir}/${entry.name}`, rel)) {
          names.push(name);
        }
      } else {
        names.push(rel as RefName);
      }
    }
    return names;
  }

  const matchesPrefix = (name: RefName, prefix: RefName | undefined): boolean =>
    prefix === undefined || name.startsWith(prefix);

  /**
   * The deepest `refs/**` subdirectory `prefix` can push the walk down to
   * before a `startsWith` filter is still needed — the directory whose
   * children are exactly `matchesPrefix`'s search space, one whole path
   * segment at a time. `undefined` when `prefix` diverges from `refs/`
   * before consuming it (nothing under `refs/**` can ever match), skipping
   * the walk entirely; never deeper than `refs/` itself, since `prefix` may
   * end mid-segment (`refs/heads/fea`) or shorter than the tree
   * (`undefined`, or a prefix of `'refs'` itself) — both of which still need
   * every sibling `matchesPrefix` alone was already filtering.
   */
  function refsWalkRoot(prefix: RefName | undefined): { readonly relative: string } | undefined {
    if (prefix === undefined || prefix.length <= REFS_DIR.length) {
      return REFS_DIR.startsWith(prefix ?? '') ? { relative: REFS_DIR } : undefined;
    }
    if (!prefix.startsWith(`${REFS_DIR}/`)) return undefined;
    const afterRefs = prefix.slice(REFS_DIR.length + 1);
    const lastSlash = afterRefs.lastIndexOf('/');
    const completeSegments = lastSlash === -1 ? '' : afterRefs.slice(0, lastSlash);
    return { relative: completeSegments === '' ? REFS_DIR : `${REFS_DIR}/${completeSegments}` };
  }

  /** `HEAD` itself, when it both matches `prefix` and actually exists — the
   *  `exists` probe is skipped entirely once the prefix already rules it
   *  out. */
  async function headCandidate(prefix: RefName | undefined): Promise<RefName | undefined> {
    if (!matchesPrefix(HEAD_NAME, prefix)) return undefined;
    return (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) ? HEAD_NAME : undefined;
  }

  /** Every name under one `refs/**` root matching `prefix`, or `[]` when the
   *  root doesn't exist — the per-root half of {@link walkAllLooseRefNames}. */
  async function walkRefsRoot(
    root: string,
    relative: string,
    prefix: RefName | undefined,
  ): Promise<ReadonlyArray<RefName>> {
    if (!(await ctx.fs.exists(root))) return [];
    const names: RefName[] = [];
    for (const name of await walkRefDir(root, relative)) {
      if (matchesPrefix(name, prefix)) names.push(name);
    }
    return names;
  }

  /**
   * Every loose ref name this Context can see matching `prefix`: `HEAD`
   * (when it matches) plus a walk of `refs/**` under both the worktree's own
   * gitdir and the common dir (the two roots collapse into a single walk
   * when they're the same directory), pushed down to {@link refsWalkRoot}'s
   * subdirectory rather than always walking the whole tree and filtering
   * every name afterward — `branchList`/`tagList`'s own single-level
   * `readdir` shape, generalised to an arbitrary prefix depth.
   */
  async function walkAllLooseRefNames(
    prefix: RefName | undefined,
  ): Promise<ReadonlyArray<RefName>> {
    const names: RefName[] = [];
    const head = await headCandidate(prefix);
    if (head !== undefined) names.push(head);
    const root = refsWalkRoot(prefix);
    if (root === undefined) return names;
    const ownRefs = `${ctx.layout.gitDir}/${root.relative}`;
    const commonRefs = `${commonGitDir(ctx)}/${root.relative}`;
    const roots = ownRefs === commonRefs ? [ownRefs] : [ownRefs, commonRefs];
    for (const walkRoot of roots) {
      names.push(...(await walkRefsRoot(walkRoot, root.relative, prefix)));
    }
    return names;
  }

  async function collectCandidateNames(prefix: RefName | undefined): Promise<ReadonlySet<RefName>> {
    const names = new Set<RefName>();
    for (const name of await walkAllLooseRefNames(prefix)) {
      names.add(name);
    }
    const packed = await loadPackedRefs();
    for (const entry of packed.entries) {
      if (matchesPrefix(entry.name, prefix)) names.add(entry.name);
    }
    return names;
  }

  /**
   * Resolve one candidate name, or `undefined` when it isn't a usable ref
   * (fails to parse — `verifyIntegrity()` reports that case on its own terms
   * — or resolves to nothing). Excluding it here, rather than aborting,
   * keeps one bad entry from taking down enumeration of every OTHER ref.
   */
  async function resolveEntry(name: RefName): Promise<RefEntry | undefined> {
    let value: ResolveDirectResult;
    try {
      value = await resolveDirect(name);
    } catch (err) {
      if (err instanceof TsgitError) return undefined;
      throw err;
    }
    return value.kind === 'missing' ? undefined : { name, value };
  }

  async function listRefs(prefix?: RefName): Promise<readonly RefEntry[]> {
    const names = await collectCandidateNames(prefix);
    const entries: RefEntry[] = [];
    for (const name of names) {
      const entry = await resolveEntry(name);
      if (entry !== undefined) entries.push(entry);
    }
    return entries.sort(byName);
  }

  async function verifyIntegrity(): Promise<readonly RefIntegrityFinding[]> {
    const findings: RefIntegrityFinding[] = [];
    for (const name of await walkAllLooseRefNames(undefined)) {
      const raw = await readLooseContent(name);
      if (raw === undefined) continue;
      const content = raw.replace(/[\r\n]+$/, '');
      if (content.startsWith(SYMBOLIC_PREFIX)) continue;
      if (!LOOSE_OID_RE.test(content)) {
        findings.push({ ref: name, msgId: 'badRefContent' });
        continue;
      }
      const oid = content as ObjectId;
      // Loose-only: a pack-registry probe (multi-pack-index, delta bases…)
      // belongs to a caller's own reachability audit, not this grammar
      // check — fsck's refs-verify pass runs its own OID-presence check
      // against its scan-scoped universe once no `badRefContent` finding
      // has already flagged this ref.
      if (!(await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), oid)))) {
        findings.push({ ref: name, msgId: 'badRefOid', target: oid });
      }
    }
    return findings;
  }

  /** CAS guard shared by `set` / `setSymbolic` / `delete` — a no-op when `expected` is absent. */
  async function checkExpected(
    name: RefName,
    expected: ObjectId | 'absent' | undefined,
  ): Promise<void> {
    if (expected === undefined) return;
    const current = await resolveDirect(name);
    const actual = current.kind === 'direct' ? current.id : 'absent';
    if (expected !== actual) throw refUpdateConflict(name, expected, actual);
  }

  /** Append `reflog` through the shared gate — a no-op when no entry accompanies this update. */
  async function applyReflog(name: RefName, reflog: ReflogAppend | undefined): Promise<void> {
    if (reflog === undefined) return;
    await recordRefUpdate(ctx, name, reflog.oldId, reflog.newId, reflog.message, {
      unconditional: reflog.unconditional === true,
    });
  }

  /** Remove `name`'s reflog file. A no-op when the file is already absent. */
  async function removeReflogFile(name: RefName): Promise<void> {
    const path = reflogPath(refDir(name), name);
    if (await ctx.fs.exists(path)) {
      await ctx.fs.rm(path);
    }
  }

  /** Replace `name`'s reflog with exactly `entries` — the files backend's whole-file rewrite. */
  async function applyReflogReplace(
    update: Extract<RefUpdate, { kind: 'reflogReplace' }>,
  ): Promise<void> {
    const text = update.entries
      .map((entry) => serializeReflogLine(entry, ctx.hashConfig.hexLength))
      .join('');
    await ctx.fs.writeUtf8(reflogPath(refDir(update.name), update.name), text);
  }

  /** `name`'s reflog, oldest-first. `[]` when the file is absent. */
  async function readReflog(name: RefName): Promise<readonly ReflogEntry[]> {
    const path = reflogPath(refDir(name), name);
    if (!(await ctx.fs.exists(path))) return [];
    const stat = await ctx.fs.stat(path);
    if (stat.size > MAX_REFLOG_BYTES) {
      throw invalidReflogEntry(`reflog file exceeds ${MAX_REFLOG_BYTES} bytes`);
    }
    return parseReflog(await ctx.fs.readUtf8(path), ctx.hashConfig.hexLength);
  }

  /** Recursively walk one `logs/**` root, composing slash-joined ref names as it descends. */
  async function walkReflogDir(dir: string, prefix: string): Promise<ReadonlyArray<RefName>> {
    const entries = await ctx.fs.readdir(dir);
    const names: RefName[] = [];
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        for (const name of await walkReflogDir(`${dir}/${entry.name}`, rel)) {
          names.push(name);
        }
      } else {
        names.push(rel as RefName);
      }
    }
    return names;
  }

  /**
   * Every reflog under `logs/`, merged across the per-worktree and common
   * scopes and deduplicated — the two roots collapse into a single walk when
   * they are the same directory (a normal repo / the main worktree).
   */
  async function listReflogs(): Promise<readonly RefName[]> {
    const own = logsDir(ctx.layout.gitDir);
    const common = logsDir(commonGitDir(ctx));
    const roots = own === common ? [own] : [own, common];
    const names = new Set<RefName>();
    for (const root of roots) {
      if (!(await ctx.fs.exists(root))) continue;
      for (const name of await walkReflogDir(root, '')) {
        names.add(name);
      }
    }
    return [...names];
  }

  async function applySet(update: Extract<RefUpdate, { kind: 'set' }>): Promise<void> {
    await checkExpected(update.name, update.expected);
    const path = looseRefPath(refDir(update.name), update.name);
    const content = TEXT_ENCODER.encode(serializeDirectRef(update.id));
    await atomicWriteRef(ctx, update.name, path, content);
    await applyReflog(update.name, update.reflog);
  }

  async function applySetSymbolic(
    update: Extract<RefUpdate, { kind: 'setSymbolic' }>,
  ): Promise<void> {
    await checkExpected(update.name, update.expected);
    const path = looseRefPath(refDir(update.name), update.name);
    const content = TEXT_ENCODER.encode(serializeSymbolicRef(update.target));
    await atomicWriteRef(ctx, update.name, path, content);
    await applyReflog(update.name, update.reflog);
  }

  /**
   * Remove `name`'s loose file and tombstone its reflog. A packed-only ref
   * refuses (`delete-packed-ref` — deleting it would require a packed-refs
   * rewrite this backend doesn't perform); a ref that is neither loose nor
   * packed refuses `REF_NOT_FOUND` instead of silently succeeding.
   */
  async function applyDelete(update: Extract<RefUpdate, { kind: 'delete' }>): Promise<void> {
    await checkExpected(update.name, update.expected);
    const path = looseRefPath(refDir(update.name), update.name);
    if (await ctx.fs.exists(path)) {
      await ctx.fs.rm(path);
      await removeReflogFile(update.name);
      return;
    }
    const packed = await resolveDirect(update.name);
    if (packed.kind === 'direct') {
      throw unsupportedOperation(
        'delete-packed-ref',
        'deleting packed-only refs requires packed-refs rewrite',
      );
    }
    throw refNotFound(update.name);
  }

  async function applyOne(update: RefUpdate): Promise<void> {
    switch (update.kind) {
      case 'set':
        return applySet(update);
      case 'setSymbolic':
        return applySetSymbolic(update);
      case 'delete':
        return applyDelete(update);
      case 'reflogOnly':
        return applyReflog(update.name, update.reflog);
      case 'reflogReplace':
        return applyReflogReplace(update);
    }
  }

  async function applyRefUpdates(updates: readonly RefUpdate[]): Promise<void> {
    for (const update of updates) {
      await applyOne(update);
    }
  }

  /** Every packable ref — direct-kind (never symbolic, matching git's own
   *  `--all` exclusion), and never a per-worktree name (`HEAD`, `refs/bisect/`,
   *  …): `packed-refs` is a common-dir-only file, and git never packs a
   *  symbolic or per-worktree ref regardless of `--all`. */
  async function packableEntries(): Promise<readonly RefEntry[]> {
    const entries = await listRefs();
    return entries.filter(
      (entry) => entry.value.kind === 'direct' && !isPerWorktreeRef(entry.name),
    );
  }

  /** Follows a tag chain to its first non-tag object — the peeled OID a
   *  packed-refs entry for an annotated tag carries on its own `^` line. */
  async function peelToNonTag(id: ObjectId): Promise<ObjectId> {
    let current = id;
    let depth = 0;
    for (;;) {
      const object = await readObject(ctx, current);
      if (object.type !== 'tag') return current;
      depth += 1;
      if (exceedsMaxPeelDepth(depth, MAX_PEEL_DEPTH)) {
        throw refChainTooDeep(depth, []);
      }
      current = object.data.object;
    }
  }

  async function buildPackedEntry(entry: RefEntry): Promise<PackedRefEntry> {
    // `packableEntries` already narrowed to the `'direct'` arm.
    const { id } = entry.value as Extract<ResolveDirectResult, { kind: 'direct' }>;
    const peeled = await peelToNonTag(id);
    return peeled === id ? { name: entry.name, id } : { name: entry.name, id, peeled };
  }

  /**
   * git's `pack-refs --all`: every packable ref is rewritten into
   * `packed-refs` (traits `peeled fully-peeled sorted`, matching git's own
   * unconditional header regardless of whether any entry needs peeling),
   * and every loose file that duplicated a now-packed ref is removed.
   * Nothing to pack (an empty repository) writes nothing — `packed-refs`'s
   * OWN absence already reads back as zero entries, so an empty repo is
   * left byte-for-byte unchanged rather than gaining a header-only file.
   */
  async function packRefs(): Promise<PackRefsOutcome> {
    const packable = await packableEntries();
    if (packable.length === 0) {
      return { packedRefCount: 0, prunedLooseRefCount: 0, removedOrphanCount: 0 };
    }
    const toPrune: RefName[] = [];
    for (const entry of packable) {
      if (await ctx.fs.exists(looseRefPath(refDir(entry.name), entry.name))) {
        toPrune.push(entry.name);
      }
    }
    const entries = await Promise.all(packable.map(buildPackedEntry));
    const content = serializePackedRefs({ entries, peeling: 'fully', sorted: true });
    await ctx.fs.writeUtf8(packedRefsPath(commonGitDir(ctx)), content);
    packedCache = undefined;
    for (const name of toPrune) {
      await ctx.fs.rm(looseRefPath(refDir(name), name));
    }
    return {
      packedRefCount: packable.length,
      prunedLooseRefCount: toPrune.length,
      removedOrphanCount: 0,
    };
  }

  return {
    resolveDirect,
    applyRefUpdates,
    listRefs,
    verifyIntegrity,
    readReflog,
    listReflogs,
    packRefs,
  };
}

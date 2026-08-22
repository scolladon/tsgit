/**
 * Loose-first-then-packed ref lookup with mtime-based packed-refs cache invalidation.
 */
import { TsgitError, unsupportedOperation } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { refNotFound, refUpdateConflict } from '../../domain/refs/error.js';
import {
  type PackedRefs,
  parseLooseRef,
  parsePackedRefs,
  serializeDirectRef,
  serializeSymbolicRef,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteRef } from './atomic-write.js';
import {
  commonGitDir,
  looseObjectPath,
  looseRefPath,
  packedRefsPath,
  perWorktreeRefDir,
} from './path-layout.js';
import { recordRefUpdate } from './record-ref-update.js';
import { deleteReflog } from './reflog-store.js';

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
   * Backend-owned ref-content health: loose refs whose body is neither a
   * well-formed OID nor a `ref: <target>` line (`badRefContent`), and
   * well-formed loose OIDs with no LOOSE object backing them
   * (`badRefOid`) — a cheap local-store probe, not a pack-aware
   * reachability audit. Independent of any external reachability scope.
   */
  verifyIntegrity(): Promise<readonly RefIntegrityFinding[]>;
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
  | { readonly ref: RefName; readonly msgId: 'badRefOid'; readonly target: ObjectId };

/** A reflog entry to append, carrying what `recordRefUpdate` needs. */
export interface ReflogAppend {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly message: string;
}

/**
 * One ref mutation to apply through {@link RefStore.applyRefUpdates}. `expected`
 * is the CAS guard (an `ObjectId` the ref must currently hold, or `'absent'`
 * for "must not exist"); a mismatch throws `REF_UPDATE_CONFLICT`. `reflog`
 * appends through the same `recordRefUpdate` gate a direct call would —
 * `reflogOnly` is the shape for a log entry with no accompanying ref write
 * (e.g. the coupled-HEAD entry a branch update also produces).
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

/** Byte-wise total order over ref names, matching git's own ref ordering (never `localeCompare`). */
const byName = (a: RefEntry, b: RefEntry): number => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

export function createRefStore(ctx: Context): RefStore {
  let packedCache: { readonly parsed: PackedRefs; readonly mtimeKey: string } | undefined;

  const refDir = (name: RefName): string => perWorktreeRefDir(ctx, name);

  async function loadPackedRefs(): Promise<PackedRefs> {
    const path = packedRefsPath(commonGitDir(ctx));
    if (!(await ctx.fs.exists(path))) {
      return { entries: [], peeling: 'none', sorted: false };
    }
    const stat = await ctx.fs.stat(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (packedCache !== undefined && packedCache.mtimeKey === key) {
      return packedCache.parsed;
    }
    const content = await ctx.fs.readUtf8(path);
    const parsed = parsePackedRefs(content);
    packedCache = { parsed, mtimeKey: key };
    return parsed;
  }

  async function readLooseContent(name: RefName): Promise<string | undefined> {
    const path = looseRefPath(refDir(name), name);
    if (!(await ctx.fs.exists(path))) return undefined;
    return ctx.fs.readUtf8(path);
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
    for (const entry of packed.entries) {
      if (entry.name === name) {
        return { kind: 'direct', id: entry.id };
      }
    }
    return { kind: 'missing' };
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

  /**
   * Every loose ref name this Context can see: `HEAD` plus a full walk of
   * `refs/**` under both the worktree's own gitdir and the common dir (the
   * two roots collapse into a single walk when they're the same directory).
   */
  async function walkAllLooseRefNames(): Promise<ReadonlyArray<RefName>> {
    const names: RefName[] = [];
    if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
      names.push(HEAD_NAME);
    }
    const ownRefs = `${ctx.layout.gitDir}/${REFS_DIR}`;
    const commonRefs = `${commonGitDir(ctx)}/${REFS_DIR}`;
    const roots = ownRefs === commonRefs ? [ownRefs] : [ownRefs, commonRefs];
    for (const root of roots) {
      if (!(await ctx.fs.exists(root))) continue;
      for (const name of await walkRefDir(root, REFS_DIR)) {
        names.push(name);
      }
    }
    return names;
  }

  const matchesPrefix = (name: RefName, prefix: RefName | undefined): boolean =>
    prefix === undefined || name.startsWith(prefix);

  async function collectCandidateNames(prefix: RefName | undefined): Promise<ReadonlySet<RefName>> {
    const names = new Set<RefName>();
    for (const name of await walkAllLooseRefNames()) {
      if (matchesPrefix(name, prefix)) names.add(name);
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
    for (const name of await walkAllLooseRefNames()) {
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
    await recordRefUpdate(ctx, name, reflog.oldId, reflog.newId, reflog.message);
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
      await deleteReflog(ctx, update.name);
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
    }
  }

  async function applyRefUpdates(updates: readonly RefUpdate[]): Promise<void> {
    for (const update of updates) {
      await applyOne(update);
    }
  }

  return {
    resolveDirect,
    applyRefUpdates,
    listRefs,
    verifyIntegrity,
  };
}

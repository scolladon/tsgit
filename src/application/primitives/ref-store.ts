/**
 * Loose-first-then-packed ref lookup with mtime-based packed-refs cache invalidation.
 */
import { dirname, fileExists, notADirectory, TsgitError } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import { concatBytes } from '../../domain/objects/encoding.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { invalidReflogEntry } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import {
  parseReflogBytes,
  parseReflogLenientBytes,
  serializeReflogRewriteLineBytes,
} from '../../domain/reflog/reflog-format.js';
import {
  invalidRef,
  type ReftableCheck,
  refChainTooDeep,
  refCycleDetected,
  refLocked,
  refUpdateConflict,
} from '../../domain/refs/error.js';
import {
  isPerWorktreeRef,
  isSafeRefName,
  type PackedRefEntry,
  parseLooseRef,
  parsePackedRefs,
  serializeDirectRef,
  serializePackedRefs,
  serializeSymbolicRef,
} from '../../domain/refs/index.js';
import { packedRefsWithout } from '../../domain/refs/packed-refs.js';
import { isRefsLinkText } from '../../domain/repository/head-ref.js';
import type { Context } from '../../ports/context.js';
import type { DirEntry, FileStat } from '../../ports/file-system.js';
import { atomicWriteFile, atomicWriteRef, withLockFile } from './atomic-write.js';
import { boundedMapFor } from './internal/concurrency.js';
import { invalidateHeadSlot, readHeadFile } from './internal/head-file.js';
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
const TEXT_DECODER = new TextDecoder();

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
   * separately-observable mutations. A run of consecutive deletes is one
   * transaction: every compare-and-swap is checked before anything changes,
   * and the files backend locks and rewrites `packed-refs` once for the run.
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
   * Every ref NAME this backend knows, merged across scopes, deduplicated,
   * sorted — {@link listRefs} without resolving a single one, for a caller
   * that only ever reads `.name` off the result. Deliberately unfiltered,
   * unlike `listRefs`: a loose ref whose content fails to parse still
   * contributes its name here, because the files backend never opens the
   * file to find out.
   *
   * That is an enumeration contract, NOT a claim to match any one git
   * command — git itself is not consistent here, measured at 2.55.0 on a
   * repository carrying one unparseable loose ref: `for-each-ref` and
   * `branch` warn `ignoring broken ref` and omit it (exit 0), while
   * `rev-list --branches` and `bundle create --all` refuse outright with
   * `fatal: bad object`. Skip-or-refuse is therefore the CALLER's policy to
   * pick, and each one already does: `rev-list`, `fsck` and `reflog expire`
   * tolerate, `bundle create` propagates. Filtering here would impose
   * for-each-ref's answer on every caller — including the ones git makes
   * fatal — and would cost one file read per loose name to discover
   * something no caller had asked about.
   */
  listRefNames(prefix?: RefName): Promise<readonly RefName[]>;
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
  /**
   * Same contract as {@link readReflog}, except a line that does not parse is
   * skipped instead of failing the whole file — an object reachable only
   * from that ONE entry stays rooted rather than silently falling out of a
   * retention scan over one malformed neighbour. The `MAX_REFLOG_BYTES` cap
   * still throws: an over-cap reflog that silently rooted nothing would be
   * the exact silent-data-loss shape leniency must not create. Every I/O
   * fault still propagates.
   */
  readReflogLenient(name: RefName): Promise<readonly ReflogEntry[]>;
  /**
   * Moves `from`'s reflog onto `to`, leaving `from` with none. When `from`
   * has no reflog this is a pure no-op on both backends: whether `to`'s
   * existing log survives is the caller's decision (a forced rename drops it
   * first). Otherwise, per backend:
   * - files: `from`'s file is renamed onto `to`'s — `to`'s log becomes
   *   exactly `from`'s, byte for byte (a malformed line survives verbatim),
   *   replacing whatever `to` had.
   * - reftable: `from`'s live records are re-keyed onto `to`, each at its
   *   own update index, MERGED into `to`'s live history rather than
   *   replacing it; `from`'s records are tombstoned.
   */
  moveReflog(from: RefName, to: RefName): Promise<void>;
  /**
   * Copies `from`'s reflog onto `to`, leaving `from`'s own log untouched —
   * unlike {@link moveReflog}, both names carry the history afterward;
   * `from` having no reflog is a pure no-op. Only a reftable rename of a
   * symbolic tracking ref copies a log today; the files arm stays so that
   * `RefStore` remains one backend-neutral port — narrowing the method to
   * the reftable store would force its one caller to cast by backend.
   */
  copyReflog(from: RefName, to: RefName): Promise<void>;
  /**
   * Whether `name` has a reflog at all — a file-presence question
   * independent of entry count (an emptied-but-present log still counts,
   * matching real git), and independent of `listReflogs`'s whole-tree walk:
   * the files backend answers with one `exists` probe on `name`'s own
   * reflog path, never a `logs/**` enumeration of every OTHER ref's.
   */
  hasReflog(name: RefName): Promise<boolean>;
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
 * Store cache, keyed on `Context` object identity — deliberately NOT on
 * `ctx.session`, unlike every other cache this plan re-keys.
 *
 * A `RefStore` closes over `ctx` at construction and reads far more of it
 * than just `layout.gitDir` during its lifetime: `packRefs()` peels tags via
 * `readObject(ctx, …)` (itself sensitive to `ctx.fs`, `ctx.hashConfig`,
 * `ctx.promisor`, `ctx.deltaCache`) and pools that work through
 * `boundedMapFor(ctx, 'ioBound', …)` (sensitive to `ctx.concurrency`).
 * Sharing the whole object across two Context values that agree on session
 * (and even gitDir) but differ in `fs` or `concurrency` — exactly the shape
 * a test takes when it swaps in a failing/proxied `fs` or an explicit
 * concurrency override via `{ ...ctx, fs: proxy }` / `{ ...ctx, concurrency }`
 * — silently resolves every read/write against the WRONG fs or ignores the
 * override, because the cached store keeps using whichever Context built it
 * first. Measured: both shapes broke real tests before this cache was
 * pinned back to literal identity. A compound key naming every field the
 * closure touches would have to name nearly the whole Context to stay safe,
 * which is indistinguishable from identity — so identity is what this cache
 * uses.
 *
 * This is not a regression for the cross-worktree win a session token
 * unlocks: `listWorktrees` (`list-worktrees.ts`) delivers it by reusing the
 * SAME `mainCtx` object for every worktree's shared-ref lookup, which hits
 * this very identity-keyed cache on every call after the first — no
 * session-keying required.
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

const HEAD_NAME: RefName = 'HEAD' as RefName;
/** The stat failures that mean "no directory here": the path, or a
 *  component above it, is absent or a regular file. */
const NOT_A_DIRECTORY_PATH_CODES: ReadonlySet<string> = new Set([
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
]);
/** The removal failures that end an empty-parent climb, as a failing
 *  `rmdir` ends git's: the directory is still non-empty (the browser
 *  adapter reports that as absent) or already gone. Never "not a
 *  directory": the climb starts on a known directory, whose ancestors are
 *  directories too. */
const UNREMOVABLE_DIRECTORY_CODES: ReadonlySet<string> = new Set([
  'DIRECTORY_NOT_EMPTY',
  'FILE_NOT_FOUND',
]);

/** Whether `dir` sits strictly below an immediate child of `root` — the
 *  only directories an empty-parent climb may remove. */
const isPrunableParent = (dir: string, root: string): boolean =>
  dir.startsWith(`${root}/`) && dirname(dir) !== root;

type PathKind = 'directory' | 'file' | 'absent';

/** A loose ref's leaf, read without following it: a regular file's
 *  content, a symbolic link, or no loose ref (absent, or a directory). */
type LooseLeaf =
  | { readonly kind: 'content'; readonly content: string }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'none' };

const NO_LEAF: LooseLeaf = { kind: 'none' };
const SYMLINK_LEAF: LooseLeaf = { kind: 'symlink' };
const MISSING: ResolveDirectResult = { kind: 'missing' };

/** How the loose walk treats one directory entry: descend it, list it, or
 *  drop it. */
type ListedKind = 'directory' | 'ref' | 'unlisted';

/** The `stat` failures that drop a symbolic link from the loose walk, as a
 *  failed `stat` drops it from git's: dangling, through a regular file, or
 *  a loop. */
const UNRESOLVABLE_LINK_CODES: ReadonlySet<string> = new Set([
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
  'PERMISSION_DENIED',
]);
/** The no-follow open refusals the plain loose reader decides instead: an
 *  adapter without the open, a regular file in the path, or an unreadable
 *  regular file. */
const PLAIN_READER_CODES: ReadonlySet<string> = new Set([
  'UNSUPPORTED_OPERATION',
  'NOT_A_DIRECTORY',
  'PERMISSION_DENIED',
]);

/** The byte-smaller of two optional names. */
const smallerName = (a: RefName | undefined, b: RefName | undefined): RefName | undefined =>
  a === undefined || (b !== undefined && b < a) ? b : a;

/** One delete's loose-file footprint, resolved before any lock is taken. */
interface DeleteTarget {
  readonly name: RefName;
  readonly gitDir: string;
  readonly loose: string;
  /** Whether the loose file's parent is a directory: the loose lock is
   *  taken, and the refs tree pruned, only then. */
  readonly looseDirExists: boolean;
}

type DeleteUpdate = Extract<RefUpdate, { kind: 'delete' }>;

/** `applyRefUpdates`' unit of work: a run of consecutive deletes applied as
 *  one transaction, or any other single update. */
type UpdateRun =
  | { readonly kind: 'deletes'; readonly updates: readonly DeleteUpdate[] }
  | { readonly kind: 'one'; readonly update: Exclude<RefUpdate, DeleteUpdate> };

/** Splits `updates` into {@link UpdateRun}s, preserving their order. */
function toUpdateRuns(updates: readonly RefUpdate[]): readonly UpdateRun[] {
  const runs: UpdateRun[] = [];
  let deletes: DeleteUpdate[] = [];
  for (const update of updates) {
    if (update.kind === 'delete') {
      deletes.push(update);
      continue;
    }
    if (deletes.length > 0) runs.push({ kind: 'deletes', updates: deletes });
    deletes = [];
    runs.push({ kind: 'one', update });
  }
  if (deletes.length > 0) runs.push({ kind: 'deletes', updates: deletes });
  return runs;
}

/**
 * git's `ref_update_reject_duplicates`: a transaction naming a ref twice
 * refuses `multiple updates for ref '<name>' not allowed` — before any lock
 * or compare-and-swap, reporting the smallest duplicated name once the names
 * are sorted. `REF_CYCLE_DETECTED` is the refusal git's same "multiple
 * updates" check already maps to for a chain that meets a name twice; here
 * the name is met twice directly.
 */
function assertNoDuplicateNames(updates: readonly DeleteUpdate[]): void {
  const duplicate = smallestDuplicateName(updates);
  if (duplicate !== undefined) throw refCycleDetected([duplicate, duplicate]);
}

/** The byte-wise smallest name `updates` carries more than once. */
function smallestDuplicateName(updates: readonly DeleteUpdate[]): RefName | undefined {
  const seen = new Set<RefName>();
  let smallest: RefName | undefined;
  for (const { name } of updates) {
    if (seen.has(name) && (smallest === undefined || name < smallest)) smallest = name;
    seen.add(name);
  }
  return smallest;
}

/** The directory an empty-parent climb starts from in the refs tree, keyed
 *  with the root it must stay below. */
const refsTreeParent = (target: DeleteTarget): readonly [string, string] => [
  dirname(target.loose),
  `${target.gitDir}/${REFS_DIR}`,
];

/** {@link refsTreeParent} for the target's reflog in the logs tree. */
const logsTreeParent = (target: DeleteTarget): readonly [string, string] => [
  dirname(reflogPath(target.gitDir, target.name)),
  `${logsDir(target.gitDir)}/${REFS_DIR}`,
];

const holdsAnyName = (
  index: ReadonlyMap<RefName, PackedRefEntry>,
  names: ReadonlySet<RefName>,
): boolean => [...names].some((name) => index.has(name));

const packedCacheKey = (stat: FileStat): string => `${stat.mtimeMs}:${stat.size}`;
const REFS_DIR = 'refs';
const SYMBOLIC_PREFIX = 'ref: ';
/** Matches valid SHA-1 (40-hex) or SHA-256 (64-hex) loose-ref content. */
const LOOSE_OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function isFileNotFound(err: unknown): boolean {
  return errorDataCode(err) === 'FILE_NOT_FOUND';
}

/** The `parseLooseRef` mapping shared by every loose-content reader: `HEAD`'s file arm,
 *  `HEAD`'s read-through arm, and every other ref's loose file. */
const fromLooseContent = (content: string): ResolveDirectResult => {
  const parsed = parseLooseRef(content);
  return parsed.type === 'symbolic'
    ? { kind: 'symbolic', target: parsed.target }
    : { kind: 'direct', id: parsed.target };
};

/**
 * The refusal for content read THROUGH a symbolic link, which can point
 * outside the repository: git reports such a ref broken and never prints the
 * file it followed, so the error names only the ref — no byte of the file.
 */
const unparseableFollowedContent = (name: RefName): TsgitError =>
  invalidRef(`${name} is a symbolic link to content that is not a ref`);

/** {@link fromLooseContent} for followed content: `parseLooseRef` refuses only
 *  content that is not a ref, and that refusal carries the bytes it read. */
const fromFollowedContent = (name: RefName, content: string): ResolveDirectResult => {
  try {
    return fromLooseContent(content);
  } catch {
    throw unparseableFollowedContent(name);
  }
};

/** Byte-wise total order over ref names, matching git's own ref ordering (never `localeCompare`). */
const compareRefNames = (a: RefName, b: RefName): number => {
  // Stryker disable next-line EqualityOperator: equivalent — every array this sorts is pre-deduplicated (a Set), so a === b never occurs and <= behaves exactly like < on the only reachable inputs.
  if (a < b) return -1;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — reachable only when a > b (uniqueness above rules out a === b); Array.prototype.sort orders purely off the < 0 sign from the branch above, so true/false/>=/<= here all yield the identical sorted result (verified empirically across 2000 randomized unique-key trials, sizes 3-32).
  if (a > b) return 1;
  return 0;
};

const byName = (a: RefEntry, b: RefEntry): number => compareRefNames(a.name, b.name);

/** Backend dispatcher: `ctx.layout.refStorage` picks the files or reftable
 *  implementation. `getRefStore`'s `Context`-keyed memo (below) is what
 *  keeps this a one-shot decision per Context. */
export function createRefStore(ctx: Context): RefStore {
  return ctx.layout.refStorage === 'reftable'
    ? createReftableRefStore(ctx)
    : createFilesRefStore(ctx);
}

/** `loadPackedRefs`'s own return shape: the parsed entries (for a full scan —
 *  `collectCandidateNames`/`listRefNames`'s enumeration walks `entries`
 *  directly and has no name to index by) alongside a LAZY name-indexed
 *  `Map` of the SAME entries, built only on its first call, so a point
 *  lookup (`resolveDirect`) never falls back to a linear scan over every
 *  packed ref — but the bench-tracked enumeration path, which never reads
 *  it, no longer pays for the `Map` construction (or retains the P-entry
 *  index) it never needed. Built once per `loaded` instance and memoised
 *  inside the closure, so repeated `resolveDirect` calls against the SAME
 *  cached `loaded` share one `Map`, not one per call. Always internally
 *  consistent — never a stale index alongside fresh `entries` or vice
 *  versa, including the "packed-refs file is absent" fast path, which
 *  returns a freshly empty pair rather than whatever the mtime+size cache
 *  still holds from before the file was removed. */
interface LoadedPackedRefs {
  readonly entries: readonly PackedRefEntry[];
  readonly byName: () => ReadonlyMap<RefName, PackedRefEntry>;
  /** Each name that is an ancestor directory of a packed ref, keyed to the
   *  byte-smallest packed ref under it — built lazily, once per snapshot. */
  readonly smallestUnder: () => ReadonlyMap<string, RefName>;
}

function lazyByNameIndex(
  entries: readonly PackedRefEntry[],
): () => ReadonlyMap<RefName, PackedRefEntry> {
  let index: ReadonlyMap<RefName, PackedRefEntry> | undefined;
  return () => {
    index ??= new Map(entries.map((entry) => [entry.name, entry] as const));
    return index;
  };
}

/** Every ancestor prefix of every packed name, keyed to the smallest name under it. */
function buildSmallestUnderIndex(entries: readonly PackedRefEntry[]): ReadonlyMap<string, RefName> {
  const index = new Map<string, RefName>();
  for (const { name } of entries) {
    for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) {
      const known = index.get(name.slice(0, slash));
      if (known === undefined || name < known) index.set(name.slice(0, slash), name);
    }
  }
  return index;
}

function lazySmallestUnderIndex(
  entries: readonly PackedRefEntry[],
): () => ReadonlyMap<string, RefName> {
  let index: ReadonlyMap<string, RefName> | undefined;
  return () => {
    index ??= buildSmallestUnderIndex(entries);
    return index;
  };
}

/** A parsed snapshot's lazy indexes over `entries`. */
const loadedPackedRefs = (entries: readonly PackedRefEntry[]): LoadedPackedRefs => ({
  entries,
  byName: lazyByNameIndex(entries),
  smallestUnder: lazySmallestUnderIndex(entries),
});

const EMPTY_BY_NAME_INDEX: ReadonlyMap<RefName, PackedRefEntry> = new Map();
const EMPTY_SMALLEST_UNDER_INDEX: ReadonlyMap<string, RefName> = new Map();
const EMPTY_PACKED_REFS: LoadedPackedRefs = {
  entries: [],
  byName: () => EMPTY_BY_NAME_INDEX,
  smallestUnder: () => EMPTY_SMALLEST_UNDER_INDEX,
};

function createFilesRefStore(ctx: Context): RefStore {
  let packedCache: { readonly loaded: LoadedPackedRefs; readonly mtimeKey: string } | undefined;

  const refDir = (name: RefName): string => perWorktreeRefDir(ctx, name);

  async function loadPackedRefs(): Promise<LoadedPackedRefs> {
    const path = packedRefsPath(commonGitDir(ctx));
    let stat: FileStat;
    try {
      stat = await ctx.fs.stat(path);
    } catch (err) {
      if (isFileNotFound(err)) return EMPTY_PACKED_REFS;
      throw err;
    }
    const key = packedCacheKey(stat);
    if (packedCache !== undefined && packedCache.mtimeKey === key) {
      return packedCache.loaded;
    }
    const content = await ctx.fs.readUtf8(path);
    const { entries } = parsePackedRefs(content);
    const loaded = loadedPackedRefs(entries);
    packedCache = { loaded, mtimeKey: key };
    return loaded;
  }

  async function readLooseContent(name: RefName): Promise<string | undefined> {
    const path = looseRefPath(refDir(name), name);
    try {
      return await ctx.fs.readUtf8(path);
    } catch (err) {
      if (isFileNotFound(err)) return undefined;
      if (errorDataCode(err) === 'NOT_A_DIRECTORY') await assertNoFileInTheWay(name, path);
      // git reads a directory at a loose path as no loose ref (`EISDIR`).
      if ((await pathKind(path)) === 'directory') return undefined;
      throw err;
    }
  }

  /**
   * `HEAD` through the single reader: a symlink whose link text is a
   * `refs/`-prefixed valid refname is reported symbolic — matching git —
   * WITHOUT ever dereferencing it; any other link text is read through
   * (`resolveSymlinkedRef`); a regular file parses exactly as any other
   * loose ref does; `unusable` folds to `missing` only for the
   * `FILE_NOT_FOUND` cause, so a permission or I/O fault on `HEAD` surfaces
   * to the caller instead of masquerading as an absent ref. `HEAD` is never
   * packed, so this never falls through to `loadPackedRefs`.
   */
  async function resolveHeadDirect(): Promise<ResolveDirectResult> {
    const head = await readHeadFile(ctx);
    if (head.kind === 'symlink') {
      return resolveSymlinkedRef(HEAD_NAME, `${ctx.layout.gitDir}/HEAD`, head.linkText);
    }
    if (head.kind === 'file') return fromLooseContent(head.content);
    if (isFileNotFound(head.cause)) return MISSING;
    throw head.cause;
  }

  /** git's `read_ref_internal` symlink rule, for every loose ref: a `refs/`-prefixed VALID
   *  refname is a symref; any other link text falls through to an ordinary read of the file
   *  it names. */
  async function resolveSymlinkedRef(
    name: RefName,
    path: string,
    linkText: string,
  ): Promise<ResolveDirectResult> {
    const text = linkText.replace(/\\/g, '/');
    if (isRefsLinkText(text) && isSafeRefName(text)) {
      return { kind: 'symbolic', target: text as RefName };
    }
    return resolveFollowed(name, path);
  }

  /**
   * The file a non-refname symlink points to, read fresh on every call — for `HEAD`, never
   * slotted: the HEAD slot's identity is the link's own `lstat`, which a rewrite of the
   * followed target does not change. An absent or directory target is a missing ref, never
   * the packed value: git's followed read ends there.
   */
  async function resolveFollowed(name: RefName, path: string): Promise<ResolveDirectResult> {
    try {
      if ((await ctx.fs.stat(path)).isDirectory) return MISSING;
      return fromFollowedContent(name, await ctx.fs.readUtf8(path));
    } catch (err) {
      if (isFileNotFound(err)) return MISSING;
      throw err;
    }
  }

  /** The regular file at `path`, through a handle that refuses a symbolic
   *  link: its `fstat` also tells a directory apart. */
  async function readRegularLeaf(path: string): Promise<LooseLeaf> {
    const handle = await ctx.fs.openWithNoFollow(path, 'read');
    try {
      const stat = await handle.stat();
      if (stat.isDirectory) return NO_LEAF;
      const buffer = new Uint8Array(stat.size);
      const length = await handle.read(buffer, 0, stat.size, 0);
      return { kind: 'content', content: TEXT_DECODER.decode(buffer.subarray(0, length)) };
    } finally {
      await handle.close();
    }
  }

  /**
   * `name`'s loose leaf. git `lstat`s before it reads; a no-follow open asks
   * the same question within the calls a plain read already makes, so only a
   * refused open pays more: `PERMISSION_DENIED` one `lstat`, to tell a link
   * from an unreadable file, and any other refusal — an adapter without the
   * open, a regular file in the path — the plain reader, which decides those.
   */
  async function readLooseLeaf(name: RefName, path: string): Promise<LooseLeaf> {
    try {
      return await readRegularLeaf(path);
    } catch (err) {
      return leafAfterRefusedOpen(name, path, err);
    }
  }

  async function leafAfterRefusedOpen(
    name: RefName,
    path: string,
    err: unknown,
  ): Promise<LooseLeaf> {
    const code = errorDataCode(err);
    if (code === 'FILE_NOT_FOUND') return NO_LEAF;
    if (code === 'PERMISSION_DENIED' && (await ctx.fs.lstat(path)).isSymbolicLink) {
      return SYMLINK_LEAF;
    }
    if (!PLAIN_READER_CODES.has(code ?? '')) throw err;
    const content = await readLooseContent(name);
    return content === undefined ? NO_LEAF : { kind: 'content', content };
  }

  async function resolvePacked(name: RefName): Promise<ResolveDirectResult> {
    const entry = (await loadPackedRefs()).byName().get(name);
    return entry === undefined ? MISSING : { kind: 'direct', id: entry.id };
  }

  async function resolveDirect(name: RefName): Promise<ResolveDirectResult> {
    if (name === HEAD_NAME) return resolveHeadDirect();
    const path = looseRefPath(refDir(name), name);
    const leaf = await readLooseLeaf(name, path);
    if (leaf.kind === 'symlink') {
      return resolveSymlinkedRef(name, path, await ctx.fs.readlink(path));
    }
    if (leaf.kind === 'content') return fromLooseContent(leaf.content);
    return resolvePacked(name);
  }

  /** git's loose iterator takes a symbolic link entry's followed type: a
   *  directory is descended, anything else listed, and a link that does not
   *  resolve dropped. */
  async function followedEntryKind(path: string): Promise<ListedKind> {
    try {
      return (await ctx.fs.stat(path)).isDirectory ? 'directory' : 'ref';
    } catch (err) {
      if (UNRESOLVABLE_LINK_CODES.has(errorDataCode(err) ?? '')) return 'unlisted';
      throw err;
    }
  }

  const entryKind = (entry: DirEntry): ListedKind => (entry.isDirectory ? 'directory' : 'ref');

  /** Recursively walk one `refs/**` root, composing slash-joined ref names as it descends. */
  async function walkRefDir(dir: string, prefix: string): Promise<ReadonlyArray<RefName>> {
    const entries = await ctx.fs.readdir(dir);
    const names: RefName[] = [];
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      const rel = `${prefix}/${entry.name}`;
      const kind = entry.isSymbolicLink ? await followedEntryKind(path) : entryKind(entry);
      if (kind === 'ref') names.push(rel as RefName);
      if (kind !== 'directory') continue;
      for (const name of await walkRefDir(path, rel)) names.push(name);
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

  /**
   * Every name under one `refs/**` root matching `prefix`, or `[]` when the
   * root doesn't exist OR isn't a directory — the per-root half of {@link
   * walkAllLooseRefNames}. `refsWalkRoot` pushes the walk down to the
   * deepest COMPLETE prefix segment, which can land on a path that is
   * itself a loose ref FILE rather than a `refs/**` directory (a D/F
   * transition mid-fetch, or simply `refs/remotes/origin` colliding with a
   * ref literally named that). The pre-prefix-push-down shape (a whole-tree
   * walk plus a `startsWith` filter) silently contributed nothing for a
   * root like that too — `ctx.fs.exists` alone can't tell the two shapes
   * apart, since it answers `true` for a file just as readily as a
   * directory, so this checks `stat().isDirectory` instead.
   */
  async function walkRefsRoot(
    root: string,
    relative: string,
    prefix: RefName | undefined,
  ): Promise<ReadonlyArray<RefName>> {
    let stat: FileStat;
    try {
      stat = await ctx.fs.stat(root);
    } catch (err) {
      if (isFileNotFound(err)) return [];
      throw err;
    }
    if (!stat.isDirectory) return [];
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
      // Loop form, not `names.push(...names)` — `walkRefDir`'s own reason
      // twelve lines above applies here too: V8 caps spread-call argument
      // counts (~10^5), which a large unpacked ref space (a mirror's
      // `refs/pull/*`, a fetch not yet followed by `pack-refs`) can exceed.
      for (const name of await walkRefsRoot(walkRoot, root.relative, prefix)) {
        names.push(name);
      }
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

  /**
   * Every candidate name's resolved entry, EXCEPT a packed-only name never
   * pays the loose-miss probe (`readUtf8` ENOENT) `resolveEntry` would cost
   * it: `looseNames` (from `walkAllLooseRefNames`) resolve through {@link
   * resolveEntry} as before — pooled through the `ioBound` bucket, since
   * each is an independent read — and a packed entry not shadowed by one of
   * them is built straight from `loadPackedRefs`'s own snapshot —
   * byte-for-byte what `resolveDirect` returns for it today, without the
   * read or the `byName()` `Map` build. `boundedMapFor` preserves input
   * order, so pooling changes completion order only; the result is sorted
   * after regardless, matching {@link listRefs}'s contract.
   */
  async function listRefs(prefix?: RefName): Promise<readonly RefEntry[]> {
    const looseNames = await walkAllLooseRefNames(prefix);
    const resolved = await boundedMapFor(ctx, 'ioBound', looseNames, resolveEntry);
    const entries = resolved.filter((entry): entry is RefEntry => entry !== undefined);
    const looseSet = new Set(looseNames);
    const packed = await loadPackedRefs();
    for (const entry of packed.entries) {
      if (matchesPrefix(entry.name, prefix) && !looseSet.has(entry.name)) {
        entries.push({ name: entry.name, value: { kind: 'direct', id: entry.id } });
      }
    }
    return entries.sort(byName);
  }

  async function listRefNames(prefix?: RefName): Promise<readonly RefName[]> {
    return [...(await collectCandidateNames(prefix))].sort(compareRefNames);
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

  /** Remove `name`'s reflog file. A no-op when the file is absent, or when
   *  a directory — the logs of refs under `name` — sits at its path. */
  async function removeReflogFile(name: RefName): Promise<void> {
    await rmUnlessDirectory(reflogPath(refDir(name), name));
  }

  /** Removes the file or link at `path`; nothing when the path is absent or
   *  a directory — git's unlink leaves a directory in place, even an empty
   *  one. */
  async function rmUnlessDirectory(path: string): Promise<void> {
    if (await hasLooseFile(path)) await ctx.fs.rm(path);
  }

  /** Whether a file or link — never a directory — sits at `path`: `false`
   *  when the path, or a component above it, is absent or a regular file.
   *  git's loose-ref readers treat a directory there (`EISDIR`) and a file
   *  in its path (`ENOTDIR`) as no loose ref. */
  async function hasLooseFile(path: string): Promise<boolean> {
    try {
      return !(await ctx.fs.lstat(path)).isDirectory;
    } catch (err) {
      if (NOT_A_DIRECTORY_PATH_CODES.has(errorDataCode(err) ?? '')) return false;
      throw err;
    }
  }

  /**
   * Replace `name`'s reflog with exactly `entries` — the files backend's
   * whole-file rewrite. `runExpire` runs this on every ref on every call, so
   * a torn write here would be routine rather than rare; locked-then-renamed
   * through {@link atomicWriteFile}, the same shape git itself takes for a
   * reflog rewrite. Serializes in BYTES: an entry carrying `raw` (parsed
   * from disk) re-emits its verbatim on-disk identity/message slices
   * instead of round-tripping through a decode/re-encode that would mangle
   * non-UTF-8 content.
   */
  async function applyReflogReplace(
    update: Extract<RefUpdate, { kind: 'reflogReplace' }>,
  ): Promise<void> {
    const content = concatBytes(
      update.entries.map((entry) =>
        serializeReflogRewriteLineBytes(entry, ctx.hashConfig.hexLength),
      ),
    );
    await atomicWriteFile(ctx, reflogPath(refDir(update.name), update.name), content, () =>
      refLocked(update.name),
    );
  }

  /** `name`'s reflog bytes, or `undefined` when the file is absent. Refuses
   *  an over-cap file — the one preamble {@link readReflog} and {@link
   *  readReflogLenient} share, so the cap and the exists/stat probe are
   *  enforced exactly once regardless of which parse strictness the caller
   *  wants. */
  async function readReflogBytes(name: RefName): Promise<Uint8Array | undefined> {
    const path = reflogPath(refDir(name), name);
    // One stat instead of an exists probe (itself a stat) + stat: absent is
    // the common miss, and a DIRECTORY at the path — the D/F shape a sibling
    // `<name>/x` log creates — reads as "no reflog", the same answer
    // `hasReflog` gives, never a raw EISDIR from the read below.
    let size: number;
    try {
      const stat = await ctx.fs.stat(path);
      if (!stat.isFile) return undefined;
      size = stat.size;
    } catch (err) {
      if (isFileNotFound(err)) return undefined;
      throw err;
    }
    if (size > MAX_REFLOG_BYTES) {
      throw invalidReflogEntry(`reflog file exceeds ${MAX_REFLOG_BYTES} bytes`);
    }
    return ctx.fs.read(path);
  }

  /** `name`'s reflog, oldest-first. `[]` when the file is absent. */
  async function readReflog(name: RefName): Promise<readonly ReflogEntry[]> {
    const bytes = await readReflogBytes(name);
    return bytes === undefined ? [] : parseReflogBytes(bytes, ctx.hashConfig.hexLength);
  }

  /**
   * `name`'s reflog, oldest-first, tolerating a malformed LINE — skipped,
   * never discarding the file's other valid entries the way {@link
   * readReflog}'s all-or-nothing parse does. Pinned against git 2.55.0:
   * `git gc --prune=now` keeps an object reachable only from a valid entry
   * that shares a reflog file with a garbage line. The `MAX_REFLOG_BYTES`
   * cap is still enforced by the shared {@link readReflogBytes} preamble and
   * is NOT tolerated here: an over-cap reflog that silently rooted nothing
   * would be the exact silent-data-loss shape leniency must not create, so
   * that fault still throws and aborts the caller's run. `[]` when the file
   * is absent, matching `readReflog`.
   */
  async function readReflogLenient(name: RefName): Promise<readonly ReflogEntry[]> {
    const bytes = await readReflogBytes(name);
    return bytes === undefined ? [] : parseReflogLenientBytes(bytes, ctx.hashConfig.hexLength);
  }

  /**
   * `rename(2)`s `from`'s reflog file onto `to`'s — byte-preserving, so a
   * malformed line moves verbatim without ever being parsed. When `from`
   * has none this is a pure no-op: whether `to`'s existing log survives is
   * the CALLER's question, not the move's — git keeps an orphan log (no
   * live ref underneath) and appends to it, while a forced rename over a
   * live ref drops the old log via its ref delete (measured, git 2.55.0).
   * The `hasReflog` probe (not a bare `exists`) keeps a directory at
   * `logs/<from>` — the D/F shape a sibling `<from>/x` log creates — from
   * being renamed wholesale.
   */
  async function moveReflog(from: RefName, to: RefName): Promise<void> {
    if (!(await hasReflog(from))) return;
    const src = reflogPath(refDir(from), from);
    await ctx.fs.rename(src, reflogPath(refDir(to), to));
  }

  /**
   * Reads `from`'s reflog bytes and writes them to `to`'s path, leaving
   * `from`'s own file in place — the same byte-preserving copy `moveReflog`
   * does, minus the deletion. `from` having no reflog is a pure no-op.
   */
  async function copyReflog(from: RefName, to: RefName): Promise<void> {
    if (!(await hasReflog(from))) return;
    const bytes = await ctx.fs.read(reflogPath(refDir(from), from));
    await ctx.fs.write(reflogPath(refDir(to), to), bytes);
  }

  /** Whether `name` has a reflog FILE — never a directory. `ctx.fs.exists`
   *  alone answers "does something live at this path" and returns `true`
   *  for a directory too, which a name like `refs/heads/feature` collides
   *  with the moment a sibling `refs/heads/feature/x` also has a reflog
   *  (`logs/refs/heads/feature` is then a directory, not `feature`'s own
   *  file). Measured against git 2.55.0: `git reflog exists` requires a
   *  regular file (`S_ISREG`) and reports absent for that same directory
   *  shape. */
  async function hasReflog(name: RefName): Promise<boolean> {
    const path = reflogPath(refDir(name), name);
    try {
      return (await ctx.fs.stat(path)).isFile;
    } catch (err) {
      if (isFileNotFound(err)) return false;
      throw err;
    }
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
    await writeLooseRef(update.name, TEXT_ENCODER.encode(serializeDirectRef(update.id)));
    if (update.name === HEAD_NAME) invalidateHeadSlot(ctx);
    await applyReflog(update.name, update.reflog);
  }

  async function applySetSymbolic(
    update: Extract<RefUpdate, { kind: 'setSymbolic' }>,
  ): Promise<void> {
    await checkExpected(update.name, update.expected);
    await writeLooseRef(update.name, TEXT_ENCODER.encode(serializeSymbolicRef(update.target)));
    if (update.name === HEAD_NAME) invalidateHeadSlot(ctx);
    await applyReflog(update.name, update.reflog);
  }

  const packedRefsLocked = (path: string): TsgitError =>
    new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'ref', path });

  /** What sits at `path` — `absent` also when a component above it is a
   *  regular file. */
  async function pathKind(path: string): Promise<PathKind> {
    try {
      return (await ctx.fs.stat(path)).isDirectory ? 'directory' : 'file';
    } catch (err) {
      if (NOT_A_DIRECTORY_PATH_CODES.has(errorDataCode(err) ?? '')) return 'absent';
      throw err;
    }
  }

  async function isDirectoryPath(dir: string): Promise<boolean> {
    return (await pathKind(dir)) === 'directory';
  }

  /** The regular file sitting at `dir` or at the nearest existing path above
   *  it, searched while below `root`; `undefined` when that path is a
   *  directory (or nothing exists below `root`). */
  async function fileInTheWay(dir: string, root: string): Promise<string | undefined> {
    if (!dir.startsWith(`${root}/`)) return undefined;
    const kind = await pathKind(dir);
    if (kind === 'absent') return fileInTheWay(dirname(dir), root);
    return kind === 'file' ? dir : undefined;
  }

  /**
   * git's lock refuses a ref whose directory is blocked by a regular file —
   * `'refs/remotes/q' exists; cannot create 'refs/remotes/q/z'` — before
   * anything changes. tsgit refuses `NOT_A_DIRECTORY` naming that file, the
   * same data on every adapter, whatever each reports for a path under it.
   */
  async function assertNoFileInTheWay(name: RefName, loose: string): Promise<void> {
    const blocking = await fileInTheWay(dirname(loose), `${refDir(name)}/${REFS_DIR}`);
    if (blocking !== undefined) throw notADirectory(blocking);
  }

  /** `atomicWriteRef` onto `name`'s loose file. A lock that cannot be created
   *  for a path reason checks for a file in the way, so a normal write pays
   *  no extra `stat`. */
  async function writeLooseRef(name: RefName, content: Uint8Array): Promise<void> {
    const path = looseRefPath(refDir(name), name);
    try {
      await atomicWriteRef(ctx, name, path, content, () => refuseRefsUnderIfPacked(name));
    } catch (err) {
      const code = errorDataCode(err) ?? '';
      if (NOT_A_DIRECTORY_PATH_CODES.has(code)) await assertNoFileInTheWay(name, path);
      if (code === 'PERMISSION_DENIED') await refuseRefsUnder(name);
      throw err;
    }
  }

  /** The byte-smallest loose ref under `name`'s loose path, when a directory
   *  sits there. */
  async function smallestLooseRefUnder(name: RefName): Promise<RefName | undefined> {
    const dir = looseRefPath(refDir(name), name);
    if ((await pathKind(dir)) !== 'directory') return undefined;
    const names = (await walkRefDir(dir, name)).filter((under) => isSafeRefName(under));
    return names.reduce<RefName | undefined>(smallerName, undefined);
  }

  /**
   * git refuses to create a ref other refs sit under — `'refs/remotes/d/x'
   * exists; cannot create 'refs/remotes/d'` — once its lock is held and before
   * anything is written. tsgit refuses `FILE_EXISTS` naming the byte-smallest
   * such ref's loose path, loose or packed alike.
   */
  async function refuseRefsUnder(name: RefName): Promise<void> {
    const packed = (await loadPackedRefs()).smallestUnder().get(name);
    const under = smallerName(packed, await smallestLooseRefUnder(name));
    if (under !== undefined) throw fileExists(looseRefPath(refDir(under), under));
  }

  /** {@link refuseRefsUnder}, paid only when the packed snapshot holds a ref
   *  under `name`: a loose ref under it surfaces through the rename the
   *  directory refuses, so a normal write costs one packed-refs `stat`. */
  async function refuseRefsUnderIfPacked(name: RefName): Promise<void> {
    if (!name.startsWith(`${REFS_DIR}/`)) return;
    if (!(await loadPackedRefs()).smallestUnder().has(name)) return;
    await refuseRefsUnder(name);
  }

  /** Takes every lockable target's `<loose>.lock`, in order, for `body` —
   *  a target is lockable only when its loose parent is a directory: a lock
   *  file cannot exist without it, so contention there is unobservable, and
   *  taking the lock would create a directory git leaves absent (a nested
   *  absent delete must leave no `refs/heads/deep/` behind). A held lock
   *  refuses `REF_LOCKED { name }` before the packed-refs lock is ever
   *  attempted; every lock already taken is released on the way out. */
  async function withLooseRefLocks(
    lockable: readonly DeleteTarget[],
    index: number,
    body: () => Promise<void>,
  ): Promise<void> {
    const target = lockable[index];
    if (target === undefined) return body();
    await withLockFile(
      ctx,
      target.loose,
      () => refLocked(target.name),
      () => withLooseRefLocks(lockable, index + 1, body),
    );
  }

  /** Removes `dir` when it is empty; `false` when it is non-empty or
   *  already gone — where git's own `rmdir` climb stops. */
  async function removeEmptyDirectory(dir: string): Promise<boolean> {
    try {
      await ctx.fs.rm(dir);
      return true;
    } catch (err) {
      if (UNREMOVABLE_DIRECTORY_CODES.has(errorDataCode(err) ?? '')) return false;
      throw err;
    }
  }

  /**
   * git's `try_remove_empty_parents`: removes the now-empty directory `dir`
   * (KNOWN to be a directory — the port's `rm` also removes a file) and then
   * each empty ancestor, one removal attempt per level and no listing, never
   * reaching `root` itself or an immediate child of it (`refs/heads`,
   * `refs/remotes`, `logs/refs/heads`, …): git skips a refname's first two
   * components, so deleting the last branch leaves `refs/heads/` and
   * `logs/refs/heads/`, a two-component `refs/stash` leaves `logs/refs/`, but
   * deleting the last tracking ref under `refs/remotes/origin/` removes that
   * nested directory, loose file and log alike. Measured against git 2.55.0.
   */
  async function pruneEmptyParents(dir: string, root: string): Promise<void> {
    if (!isPrunableParent(dir, root)) return;
    if (!(await removeEmptyDirectory(dir))) return;
    await pruneEmptyParents(dirname(dir), root);
  }

  /** {@link pruneEmptyParents} for a `dir` not yet known to be a directory:
   *  one `stat` first, only when `dir` is prunable at all, so a file sitting
   *  where a parent directory would be (an orphan log) is never removed. */
  async function pruneEmptyParentsIfDirectory(dir: string, root: string): Promise<void> {
    if (!isPrunableParent(dir, root)) return;
    if (!(await isDirectoryPath(dir))) return;
    await pruneEmptyParents(dir, root);
  }

  /** Adopts `entries` — the text just renamed onto `packed-refs` — as the
   *  cached snapshot, keyed by one `stat` of the file now in place, instead
   *  of dropping the cache for the next reader to re-read and re-parse. */
  async function reseedPackedCache(entries: readonly PackedRefEntry[]): Promise<void> {
    const stat = await ctx.fs.stat(packedRefsPath(commonGitDir(ctx)));
    packedCache = { loaded: loadedPackedRefs(entries), mtimeKey: packedCacheKey(stat) };
  }

  /** Rewrites `packed-refs` without `names` — once, and only when the
   *  cached snapshot holds at least one of them: a loose-only delete leaves
   *  the file byte-unchanged and reads no more than its `stat`. */
  async function dropFromPackedRefs(
    names: ReadonlySet<RefName>,
    commitPacked: (content: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const packed = await loadPackedRefs();
    if (!holdsAnyName(packed.byName(), names)) return;
    const rewrite = packedRefsWithout(packed.entries, names);
    await commitPacked(TEXT_ENCODER.encode(rewrite.content));
    await reseedPackedCache(rewrite.entries);
  }

  async function removeLooseAndLog(target: DeleteTarget): Promise<void> {
    await rmUnlessDirectory(target.loose);
    await removeReflogFile(target.name);
    if (target.name === HEAD_NAME) invalidateHeadSlot(ctx);
  }

  /**
   * git's files-backend delete order: rewrite `packed-refs` first (once for
   * the whole run), then each loose file, then its reflog. A crash between
   * them leaves a loose file holding the ref's current value, never an
   * older packed value resurrected.
   */
  async function removeEverywhere(
    targets: readonly DeleteTarget[],
    commitPacked: (content: Uint8Array) => Promise<void>,
  ): Promise<void> {
    await dropFromPackedRefs(new Set(targets.map((target) => target.name)), commitPacked);
    for (const target of targets) await removeLooseAndLog(target);
  }

  /** A delete's target, refusing a file in the way before any lock. */
  async function deleteTargetFor(update: DeleteUpdate): Promise<DeleteTarget> {
    const gitDir = refDir(update.name);
    const loose = looseRefPath(gitDir, update.name);
    const looseDirExists = await isDirectoryPath(dirname(loose));
    if (!looseDirExists) await assertNoFileInTheWay(update.name, loose);
    return { name: update.name, gitDir, loose, looseDirExists };
  }

  /** Both trees' empty-parent pruning, each distinct parent once, for the
   *  names nested under `refs/` — a bare pseudo-ref like `HEAD` has no such
   *  directory. The refs tree is pruned only where the loose parent was a
   *  directory; the logs tree whether or not a ref had a log, as git's own
   *  unlink-then-prune treats an absent log. */
  async function pruneDeletedParents(targets: readonly DeleteTarget[]): Promise<void> {
    const nested = targets.filter((target) => target.name.startsWith(`${REFS_DIR}/`));
    const lockable = nested.filter((target) => target.looseDirExists);
    for (const [dir, root] of new Map(lockable.map(refsTreeParent))) {
      await pruneEmptyParents(dir, root);
    }
    for (const [dir, root] of new Map(nested.map(logsTreeParent))) {
      await pruneEmptyParentsIfDirectory(dir, root);
    }
  }

  /**
   * Deletes a run of refs as ONE git files-backend transaction: every
   * compare-and-swap is checked first, then each loose ref is locked (when
   * its directory exists) and `packed-refs` is locked once, the names are
   * dropped from `packed-refs` in one rewrite, and each loose file and log is
   * removed. Every lock is taken even for an absent ref — the delete's no-op
   * is proven by nothing changing, not by a refusal. Empty-parent pruning
   * runs AFTER the locks are released — a lock file lives in the directory
   * being pruned — matching git's unlock-then-`try_remove_empty_parents`.
   */
  async function applyDeletes(updates: readonly DeleteUpdate[]): Promise<void> {
    assertNoDuplicateNames(updates);
    for (const update of updates) await checkExpected(update.name, update.expected);
    const targets = await boundedMapFor(ctx, 'ioBound', updates, deleteTargetFor);
    const lockable = targets.filter((target) => target.looseDirExists);
    await withLooseRefLocks(lockable, 0, () =>
      withLockFile(ctx, packedRefsPath(commonGitDir(ctx)), packedRefsLocked, (commit) =>
        removeEverywhere(targets, commit),
      ),
    );
    await pruneDeletedParents(targets);
  }

  async function applyOne(update: Exclude<RefUpdate, DeleteUpdate>): Promise<void> {
    switch (update.kind) {
      case 'set':
        return applySet(update);
      case 'setSymbolic':
        return applySetSymbolic(update);
      case 'reflogOnly':
        return applyReflog(update.name, update.reflog);
      case 'reflogReplace':
        return applyReflogReplace(update);
    }
  }

  /** Applies `updates` in order, each consecutive run of deletes as one
   *  transaction ({@link applyDeletes}). */
  async function applyRefUpdates(updates: readonly RefUpdate[]): Promise<void> {
    for (const run of toUpdateRuns(updates)) {
      await (run.kind === 'deletes' ? applyDeletes(run.updates) : applyOne(run.update));
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
    // Pooled through the same `ioBound` bucket `buildPackedEntry` uses below
    // — each probe is an independent read, and `boundedMapFor`'s
    // input-order result lets `toPrune` stay filtered in packable order.
    const dupeExists = await boundedMapFor(ctx, 'ioBound', packable, (entry) =>
      hasLooseFile(looseRefPath(refDir(entry.name), entry.name)),
    );
    const toPrune = packable
      .filter((_entry, index) => dupeExists[index] === true)
      .map((entry) => entry.name);
    const entries = await boundedMapFor(ctx, 'ioBound', packable, buildPackedEntry);
    const content = serializePackedRefs({ entries, peeling: 'fully', sorted: true });
    await ctx.fs.writeUtf8(packedRefsPath(commonGitDir(ctx)), content);
    packedCache = undefined;
    // A mid-way failure here leaves an arbitrary subset of `toPrune` pruned
    // rather than a prefix — safe because `packed-refs` is already written:
    // any surviving loose duplicate holds the same value packed-refs does.
    await boundedMapFor(ctx, 'ioBound', toPrune, (name) =>
      ctx.fs.rm(looseRefPath(refDir(name), name)),
    );
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
    listRefNames,
    verifyIntegrity,
    readReflog,
    readReflogLenient,
    moveReflog,
    copyReflog,
    hasReflog,
    listReflogs,
    packRefs,
  };
}

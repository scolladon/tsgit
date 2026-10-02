import { TsgitError } from '../../../../domain/error.js';
import { errorDataCode } from '../../../../domain/error-data-code.js';
import type { CacheTreeEntry, GitIndex } from '../../../../domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../domain/git-index/index-parser.js';
import { parseResolveUndo } from '../../../../domain/git-index/resolve-undo.js';
import type { ObjectId, RefName } from '../../../../domain/objects/index.js';
import { FILE_MODE, zeroOid } from '../../../../domain/objects/index.js';
import type { ReflogEntry } from '../../../../domain/reflog/reflog-entry.js';
import { isPerWorktreeRef } from '../../../../domain/refs/per-worktree-ref.js';
import { resolveWorktreePath } from '../../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../../ports/context.js';
import { deriveContext } from '../../../primitives/derive-context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { boundedMapFor } from '../../../primitives/internal/concurrency.js';
import { deriveWorktreeContext } from '../../../primitives/internal/worktree-context.js';
import { commonGitDir, indexPath } from '../../../primitives/path-layout.js';
import { readIndex } from '../../../primitives/read-index.js';
import { listReflogs, readReflogLenient } from '../../../primitives/reflog-store.js';
import { resolveRef } from '../../../primitives/resolve-ref.js';
import { objectIsPresent } from './object-presence.js';
import type { FsckOptions } from './types.js';
import { hashesToItsId } from './verified-copies.js';

const HEAD_REF = 'HEAD' as RefName;

const CACHE_TREE_SIGNATURE = 'TREE';
const RESOLVE_UNDO_SIGNATURE = 'REUC';
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE_TYPE = 0o100000;

/**
 * The only faults an index read or a cache-tree decode is allowed to be
 * quiet about, named positively so nothing else can slip through: an index
 * whose bytes do not form an index, and a `TREE` extension whose payload
 * does not form a cache-tree. Both are what git itself tolerates — its own
 * `read_index` leaves `cache_tree` NULL for an extension it cannot decode,
 * and runs no cache-tree check at all. Any OTHER error (a permission fault,
 * an abort) means the check never ran, and a check that never ran must not
 * be reported as a check that passed.
 */
const TOLERATED_INDEX_CODES: ReadonlySet<string> = new Set([
  'INVALID_INDEX_HEADER',
  'INVALID_INDEX_ENTRY',
]);

function isToleratedIndexFault(err: unknown): boolean {
  return err instanceof TsgitError && TOLERATED_INDEX_CODES.has(err.data.code);
}

/**
 * The one artefact-STRUCTURE refusal a presence probe can raise on which the
 * cache-tree check withholds its verdict for that entry instead of reading
 * it as an unresolvable tree oid: a multi-pack-index whose routing for this
 * very oid does not decode, the deferred `pack-int-id` / `large-offset`
 * check `lookup` resolves per entry. It names a broken ROUTE, never a
 * missing object — git resolves the same oid through the artefact it can
 * still read and reports the artefact itself, so claiming a missing entry
 * point here would invent a fault git does not report. Nothing is lost: this
 * same `fsck` run surfaces it from the midx-health pass that owns it, under
 * its own exit bit.
 *
 * Deliberately no wider than that, and narrowed on `check` rather than on
 * `code` alone so containment reads off the predicate itself instead of off
 * pass order: every OTHER `MidxCheck` is a load-time refusal that has already
 * denied the whole run before this pass is reached, and would reject here too
 * were a future one ever to arrive through a lookup. A lookup-layer
 * `INVALID_PACK_INDEX` is a MID-READ corruption `pack-shared.ts` refuses to
 * launder into a miss, and no pass re-reports it, so it rejects the run here
 * exactly as it does through `refs-verify.ts`'s call to the same probe. A
 * permission fault, an abort, or anything unforeseen rejects it for the same
 * reason: a check that never ran must not be reported as a check that passed.
 */
export function isContainedLookupFault(err: unknown): boolean {
  if (!(err instanceof TsgitError) || err.data.code !== 'INVALID_MULTI_PACK_INDEX') return false;
  return err.data.check === 'pack-int-id' || err.data.check === 'large-offset';
}

/** Whether an index pointer resolves: `undefined` when the run cannot say. */
type Probe = (ctx: Context, id: ObjectId) => Promise<boolean | undefined>;

/** `objectIsPresent`, with the refusal above answered `undefined` — "this
 *  run cannot say", as distinct from `false`'s "the object is absent". */
async function probePresence(ctx: Context, id: ObjectId): Promise<boolean | undefined> {
  try {
    return await objectIsPresent(ctx, id);
  } catch (err) {
    if (!isContainedLookupFault(err)) throw err;
    return undefined;
  }
}

/**
 * The verdicts a ref resolution is allowed to fail with — an unborn HEAD, a
 * dangling/cyclical symref, or content that never named a valid ref at all.
 * `collectRetentionRoots`'s strict mode tolerates exactly these (a ref that
 * genuinely isn't one roots nothing, same as `collectRoots`) and rethrows
 * everything else — a permission fault or an I/O error means the read never
 * happened, and a subgraph gc cannot see must never be treated as garbage.
 */
const GC_TOLERATED_REF_CODES: ReadonlySet<string> = new Set([
  'REF_NOT_FOUND',
  'INVALID_REF',
  'REF_CHAIN_TOO_DEEP',
  'REF_CYCLE_DETECTED',
]);

export function isTolerableRefFault(err: unknown): boolean {
  const code = errorDataCode(err);
  return code !== undefined && GC_TOLERATED_REF_CODES.has(code);
}

/**
 * Add every resolvable ref's target to `roots`. Returns whether any ref
 * resolved to an oid ABSENT from the universe — git probes such a target
 * against the promisor machinery (`is_promisor_object`), so the caller's
 * promisor-config gate must fire for it even though it roots nothing.
 *
 * `universe` is optional: omitted, every resolved ref target is added
 * unconditionally and the "absent target" verdict never fires — the shape
 * `collectRetentionRoots` needs (gc has no pre-built object universe to
 * bound against; unlike `collectRoots`, it never reports corruption).
 *
 * `strict` (gc-only; `collectRoots`/fsck never sets it) narrows the
 * tolerated failures to `isTolerableRefFault`'s "genuinely not a ref"
 * verdicts and rethrows anything else — see that predicate's own doc.
 */
async function addRefRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe?: ReadonlySet<ObjectId>,
  strict?: boolean,
): Promise<boolean> {
  const refNames = await enumerateRefs(ctx);
  let sawAbsentTarget = false;
  for (const ref of refNames) {
    try {
      // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
      const id = await resolveRef(ctx, ref, { peel: false });
      // Only add to roots if the OID is present in the universe.
      // Absent OIDs are reported as bad-ref(badRefOid) by the refs-verify pass
      // and must NOT be added to roots (would produce spurious 'missing' findings).
      if (universe === undefined || universe.has(id)) roots.add(id);
      else sawAbsentTarget = true;
    } catch (err) {
      if (strict === true && !isTolerableRefFault(err)) throw err;
      // Unresolvable ref (unborn, dangling symref, malformed content) — tolerated
    }
  }
  return sawAbsentTarget;
}

/**
 * Root `entries` into `roots` — the zero oid is the "no object" sentinel git
 * writes for creation events (first reflog entry of any ref) and is not a
 * real object reference, so it is never treated as a reachability root.
 * Shared by every reflog-rooting path (current-ctx and per-worktree alike).
 */
function addReflogEntryRoots(
  roots: Set<ObjectId>,
  entries: ReadonlyArray<ReflogEntry>,
  zero: ObjectId,
): void {
  for (const entry of entries) {
    if (entry.oldId !== zero) roots.add(entry.oldId);
    if (entry.newId !== zero) roots.add(entry.newId);
  }
}

/**
 * The open failures git's reflog and `gitdir` reads stop at without a word:
 * `files_for_each_reflog_ent` returns -1 when it cannot open the log, which every
 * caller discards, and `get_linked_worktree` skips a worktree whose `gitdir`
 * `strbuf_read_file` fails. Each reads as "no such file". Anything else — the
 * reflog size cap, an unclassified I/O fault — means the read never happened
 * and is rethrown.
 */
const UNOPENABLE_FILE_CODES: ReadonlySet<string> = new Set([
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'NOT_A_DIRECTORY',
]);

export const isUnopenableFile = (err: unknown): boolean =>
  UNOPENABLE_FILE_CODES.has(errorDataCode(err) ?? '');

/**
 * `ref`'s reflog read LINE-grained-leniently (`readReflogLenient`: a
 * malformed line is skipped, as git's `show_one_reflog_ent` skips it), and
 * empty when the file cannot be opened at all, as git reads a log it cannot open.
 */
async function readReflogIfOpenable(
  ctx: Context,
  ref: RefName,
): Promise<ReadonlyArray<ReflogEntry>> {
  try {
    return await readReflogLenient(ctx, ref);
  } catch (err) {
    if (!isUnopenableFile(err)) throw err;
    return [];
  }
}

/** Root every reflog's old/new oids for gc's retention walk. */
async function addReflogRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const reflogNames = await listReflogs(ctx);
  const zero = zeroOid(ctx.hashConfig);
  await boundedMapFor(ctx, 'ioBound', reflogNames, async (ref) => {
    addReflogEntryRoots(roots, await readReflogIfOpenable(ctx, ref), zero);
  });
}

/** A cache-tree walk's unresolvable oids and every tree oid it went on to
 *  parse, both in git's pre-order. */
interface CacheTreeWalk {
  readonly unresolved: ReadonlyArray<ObjectId>;
  readonly parsed: ReadonlyArray<ObjectId>;
}

const NO_CACHE_TREE: CacheTreeWalk = { unresolved: [], parsed: [] };

/** The cache-tree walk, plus the index entries git looks up as blobs and
 *  the regular-file resolve-undo stages it parses. */
interface IndexWalk extends CacheTreeWalk {
  readonly blobs: ReadonlyArray<ObjectId>;
  readonly resolveUndo: ReadonlyArray<ObjectId>;
}

const NO_INDEX: IndexWalk = { ...NO_CACHE_TREE, blobs: [], resolveUndo: [] };

/**
 * Walk the cache-tree, adding every entry's resolvable tree oid to `roots`
 * and reporting whether any entry names one that fails to resolve — git's
 * own `fsck_cache_tree` does both in the same pass: it marks each parsed
 * cache-tree oid reachable, which is why a tree written by `git write-tree`
 * and named by nothing else is not dangling (measured against git 2.55.0),
 * and errors on the one it cannot parse.
 *
 * An invalidated entry (`id` absent) has nothing to resolve and roots
 * nothing, but its children are still walked — invalidation is per-entry,
 * not inherited. An entry whose oid does not resolve roots nothing and its
 * own children are skipped, while its siblings carry on, exactly as git
 * returns from the failed entry while the enclosing loop continues.
 *
 * A probe that answers `undefined` — an artefact whose STRUCTURE refuses the
 * lookup, see `probePresence` — says nothing about THAT ONE entry: it does
 * not prove the oid unresolvable, so the verdict stays where it stood and the
 * walk carries on into that entry's own children. Nor does it withhold the
 * root, which is `universe`'s to license and never the probe's. So a
 * cannot-say answer can only ever withhold an upgrade of the verdict from
 * `false` to `true`; it never discards a `true` an earlier entry already
 * proved, and never drops the entries still queued behind it as reachability
 * roots.
 *
 * Iterative over an explicit stack: the nesting is the index's to choose,
 * and a recursive walk of a deep one would exhaust the call stack.
 */
async function walkCacheTree(
  ctx: Context,
  root: CacheTreeEntry,
  roots: Set<ObjectId>,
  probe: Probe,
  universe?: ReadonlySet<ObjectId>,
): Promise<CacheTreeWalk> {
  const stack: CacheTreeEntry[] = [root];
  const parsed: ObjectId[] = [];
  const unresolved: ObjectId[] = [];
  while (stack.length > 0) {
    const entry = stack.pop() as CacheTreeEntry;
    if (entry.id !== undefined) {
      const present = await probe(ctx, entry.id);
      if (present === false) {
        unresolved.push(entry.id);
        continue;
      }
      // `universe` membership, not the probe, is what licenses the seed —
      // the same guard `addRefRoots` applies. An oid the run's own mode kept
      // out of `universe` cannot be followed by the reachability walk and
      // would surface a spurious 'missing' finding; an oid inside it was
      // already found by this run's own scan, which is proof enough to root
      // it whatever the probe could or could not say about its route.
      // Rooting an oid the probe refused invents nothing: `buildReachableSet`
      // records no out-edge for an object whose cache entry is null, so no
      // broken edge and no missing id can follow from it. `universe`
      // omitted (gc's unbounded callers) roots every resolvable entry.
      if (universe === undefined || universe.has(entry.id)) roots.add(entry.id);
      parsed.push(entry.id);
    }
    // Reversed so the first child pops first: git's recursive pre-order.
    stack.push(...[...entry.children].reverse());
  }
  return { unresolved, parsed };
}

/** The index, or `undefined` when it is absent or its bytes do not form one. */
async function readIndexIfIntact(ctx: Context): Promise<GitIndex | undefined> {
  try {
    return await readIndex(ctx);
  } catch (err) {
    if (!isToleratedIndexFault(err)) throw err;
    return undefined;
  }
}

/** The index's cache-tree, or `undefined` when it carries no `TREE`
 *  extension or that extension's payload does not decode. */
function cacheTreeOf(ctx: Context, index: GitIndex): CacheTreeEntry | undefined {
  const extension = index.extensions.find((ext) => ext.signature === CACHE_TREE_SIGNATURE);
  if (extension === undefined) return undefined;
  try {
    return parseCacheTree(extension.data, ctx.hashConfig.digestLength);
  } catch (err) {
    if (!isToleratedIndexFault(err)) throw err;
    return undefined;
  }
}

/** Every regular-file stage id the index's `REUC` extension records — the
 *  ones git's `fsck_resolve_undo` parses; a malformed extension git drops. */
function resolveUndoIdsOf(ctx: Context, index: GitIndex): ReadonlyArray<ObjectId> {
  const extension = index.extensions.find((ext) => ext.signature === RESOLVE_UNDO_SIGNATURE);
  if (extension === undefined) return [];
  const records = parseResolveUndo(extension.data, ctx.hashConfig.digestLength) ?? [];
  return records.flatMap(({ stages }) =>
    stages.filter(({ mode }) => (mode & FILE_TYPE_MASK) === REGULAR_FILE_TYPE).map(({ id }) => id),
  );
}

/**
 * Add every index entry's oid to `roots` — every stage, never a gitlink, as
 * git's `fsck_index` and `add_index_objects_to_pending` both do — then walk the index's
 * cache-tree (`TREE` extension) — if it has one — for further roots and for
 * the unresolvable-tree-oid verdict. Called only when `indexRoot !== false`
 * — that option means "the index does not participate in this fsck run" for
 * every one of the index's roles (reachability root source, cache-tree root
 * source and cache-tree check alike), so disabling it skips the whole read
 * rather than consulting the index behind the option's back.
 *
 * Measured against git 2.55.0: neither ref resolution nor the reflog has
 * any bearing on the verdict — it is driven purely by the index's own
 * cache-tree. An index with no `TREE` extension (including no index at
 * all) contributes nothing, matching git, which runs no such check there.
 */
async function addIndexRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe?: ReadonlySet<ObjectId>,
  probe: Probe = probePresence,
): Promise<IndexWalk> {
  const index = await readIndexIfIntact(ctx);
  if (index === undefined) return NO_INDEX;
  const blobs = index.entries
    .filter((entry) => entry.mode !== FILE_MODE.GITLINK)
    .map((entry) => entry.id);
  for (const id of blobs) roots.add(id);
  const resolveUndo = resolveUndoIdsOf(ctx, index);
  const cacheTree = cacheTreeOf(ctx, index);
  if (cacheTree === undefined) return { ...NO_CACHE_TREE, blobs, resolveUndo };
  return {
    ...(await walkCacheTree(ctx, cacheTree, roots, probe, universe)),
    blobs,
    resolveUndo,
  };
}

export interface RootsCollection {
  readonly roots: ReadonlySet<ObjectId>;
  /**
   * Every cache-tree or resolve-undo oid that fails to resolve, index by
   * index in git's worktree order — git's `invalid sha1 pointer in
   * cache-tree` / `in resolve-undo`, each setting bit 8. No index, or one
   * with neither extension, yields none — vacuous absence is not a fault.
   * Ref and reflog resolution have no bearing on it.
   */
  readonly invalidIndexPointers: ReadonlyArray<InvalidIndexPointer>;
  /**
   * A ref resolved to an oid absent from the universe. git's fsck probes
   * that target through the promisor machinery, which is what makes the
   * promisor-config gate fire on a repo whose ONLY ref is broken.
   */
  readonly sawAbsentRefTarget: boolean;
  /** Every oid git's `fsck_index` parses: each index's resolvable
   *  cache-tree and resolve-undo entries, whichever store holds them. */
  readonly parsedIndexIds: ReadonlyArray<ObjectId>;
  /** Every index entry oid — git's `fsck_index` looks each one up as a blob. */
  readonly indexBlobIds: ReadonlySet<ObjectId>;
  /** Every reflog oid git's fsck never recorded as an object, in reflog order. */
  readonly invalidReflogEntries: ReadonlyArray<InvalidReflogEntry>;
}

/** An index pointer naming an object no store holds. */
export interface InvalidIndexPointer {
  readonly type: 'invalid-cache-tree-pointer' | 'invalid-resolve-undo-pointer';
  readonly id: ObjectId;
  /** The index file naming it — git's `worktree_git_path(wt, "index")`. */
  readonly index: string;
}

/** A reflog side naming an object the run never recorded: git's `invalid reflog entry`. */
export interface InvalidReflogEntry {
  readonly ref: RefName;
  readonly id: ObjectId;
}

/** Root every recorded oid of one reflog; return the rest, old side then new. */
function splitReflogEntries(
  ref: RefName,
  entries: ReadonlyArray<ReflogEntry>,
  isRecorded: (id: ObjectId) => boolean,
  roots: Set<ObjectId>,
  zero: ObjectId,
): ReadonlyArray<InvalidReflogEntry> {
  const invalid: InvalidReflogEntry[] = [];
  for (const id of entries.flatMap((entry) => [entry.oldId, entry.newId])) {
    if (id === zero) continue;
    if (isRecorded(id)) roots.add(id);
    else invalid.push({ ref, id });
  }
  return invalid;
}

/**
 * git's `fsck_handle_reflog_oid`: an oid the run recorded as an object is
 * marked reachable; any other is an `invalid reflog entry` — never a root,
 * so never reported missing. A line that does not parse is skipped, as
 * git's reflog iterator skips it, and a log that cannot be opened is absent.
 */
async function addRecordedReflogRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  isRecorded: (id: ObjectId) => boolean,
): Promise<ReadonlyArray<InvalidReflogEntry>> {
  const zero = zeroOid(ctx.hashConfig);
  const invalid: InvalidReflogEntry[] = [];
  for (const { ref: head, worktreeCtx } of await worktreeContexts(ctx)) {
    const prefix = head.slice(0, -HEAD_REF.length);
    const perReflog = await boundedMapFor(
      ctx,
      'ioBound',
      await listReflogs(worktreeCtx),
      async (ref) =>
        splitReflogEntries(
          worktreeRefName(prefix, ref),
          await readReflogIfOpenable(worktreeCtx, ref),
          isRecorded,
          roots,
          zero,
        ),
    );
    invalid.push(...perReflog.flat());
  }
  return invalid;
}

/** `ref` as the current worktree names it: another worktree's own refs carry its prefix. */
const worktreeRefName = (prefix: string, ref: RefName): RefName =>
  (isPerWorktreeRef(ref) ? `${prefix}${ref}` : ref) as RefName;

/** git's `parse_object` probe: `false` when no store holds `id` or the copy
 *  it reads first hashes to another id, `undefined` when the route cannot say. */
async function parseProbe(ctx: Context, id: ObjectId): Promise<boolean | undefined> {
  const present = await probePresence(ctx, id);
  if (present !== true) return present;
  return hashesToItsId(ctx, id);
}

/** One index's resolve-undo stages: one git parses is rooted, any other a fault. */
async function addResolveUndoRoots(
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<IndexFsck> {
  const invalid: InvalidIndexPointer[] = [];
  const parsed: ObjectId[] = [];
  for (const id of ids) {
    if ((await parseProbe(ctx, id)) === false) {
      invalid.push({
        type: 'invalid-resolve-undo-pointer',
        id,
        index: indexPath(ctx.layout.gitDir),
      });
      continue;
    }
    if (universe.has(id)) roots.add(id);
    parsed.push(id);
  }
  return { invalid, parsed, blobs: [] };
}

/** What git's `fsck_index` makes of the indexes it reads. */
interface IndexFsck {
  readonly invalid: ReadonlyArray<InvalidIndexPointer>;
  readonly parsed: ReadonlyArray<ObjectId>;
  readonly blobs: ReadonlyArray<ObjectId>;
}

const NO_INDEX_FSCK: IndexFsck = { invalid: [], parsed: [], blobs: [] };

/** git's `fsck_index` over one worktree's index: entries, cache-tree, then resolve-undo. */
async function fsckOneIndex(
  ctx: Context,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<IndexFsck> {
  const walk = await addIndexRoots(ctx, roots, universe, parseProbe);
  const undo = await addResolveUndoRoots(ctx, walk.resolveUndo, roots, universe);
  return {
    invalid: [
      ...walk.unresolved.map((id) => ({
        type: 'invalid-cache-tree-pointer' as const,
        id,
        index: indexPath(ctx.layout.gitDir),
      })),
      ...undo.invalid,
    ],
    parsed: [...walk.parsed, ...undo.parsed],
    blobs: walk.blobs,
  };
}

/** git's index loop: every worktree's index, in `get_worktrees` order. */
async function fsckEveryIndex(
  ctx: Context,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<IndexFsck> {
  let all = NO_INDEX_FSCK;
  for (const { worktreeCtx } of await worktreeContexts(ctx)) {
    const own = await fsckOneIndex(worktreeCtx, roots, universe);
    all = {
      invalid: [...all.invalid, ...own.invalid],
      parsed: [...all.parsed, ...own.parsed],
      blobs: [...all.blobs, ...own.blobs],
    };
  }
  return all;
}

/**
 * Collect all oids that serve as reachability roots:
 * - Each resolved ref (HEAD + all refs/*)
 * - Reflog old/new oids (when reflogRoots !== false)
 * - Index entry oids and resolvable cache-tree oids (when indexRoot !== false)
 *
 * Alongside the roots, reports the missing-entry-point condition — computed
 * from the same index read and the same cache-tree walk `addIndexRoots`
 * already does for reachability, no re-scan of the store beyond the bounded
 * per-oid existence probe the cache-tree check itself needs.
 */
export async function collectRoots(
  ctx: Context,
  opts: FsckOptions,
  universe: ReadonlySet<ObjectId>,
  isRecorded: (id: ObjectId) => boolean,
): Promise<RootsCollection> {
  const roots = new Set<ObjectId>();
  const sawAbsentRef = await addRefRoots(ctx, roots, universe);
  const sawAbsentHead = await addWorktreeHeadRoots(ctx, roots, universe);
  const invalidReflogEntries =
    opts.reflogRoots !== false ? await addRecordedReflogRoots(ctx, roots, isRecorded) : [];
  const index =
    opts.indexRoot !== false ? await fsckEveryIndex(ctx, roots, universe) : NO_INDEX_FSCK;
  return {
    roots,
    invalidIndexPointers: index.invalid,
    sawAbsentRefTarget: sawAbsentRef || sawAbsentHead,
    parsedIndexIds: index.parsed,
    indexBlobIds: new Set(index.blobs),
    invalidReflogEntries,
  };
}

/** Root every other worktree's HEAD git's fsck snapshots; returns whether
 *  one named an object the universe lacks (see `addRefRoots`). */
async function addWorktreeHeadRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<boolean> {
  let sawAbsentTarget = false;
  for (const { id } of await worktreeHeads(ctx)) {
    if (universe.has(id)) roots.add(id);
    else sawAbsentTarget = true;
  }
  return sawAbsentTarget;
}

/** Strip a trailing `/.git` from `dir`; absent means `dir` itself — the same
 *  "gitdir file to working-tree path" rule `listWorktrees` uses. */
const GIT_SUFFIX = '/.git';
export const stripGitSuffix = (dir: string): string =>
  dir.endsWith(GIT_SUFFIX) ? dir.slice(0, -GIT_SUFFIX.length) : dir;

/**
 * Roots a NON-CURRENT worktree's own retention state: its HEAD, its own
 * HEAD reflog, and its own index — exactly (and ONLY) what git's
 * `other_head_refs()` roots for a worktree gc is not currently running
 * from. Measured against git 2.55.0, both directions: a non-current
 * worktree's OTHER per-worktree refs (`refs/bisect/…`, `refs/worktree/…`,
 * `refs/rewritten/…`) and THEIR reflogs are PRUNED — only `logs/HEAD`
 * survives past the current HEAD ref itself; the same names root normally
 * when gc runs FROM that worktree (already covered by
 * `collectRetentionRoots`'s own direct calls against `ctx`, which this
 * function is never invoked for). Reading only `${adminDir}/HEAD` and
 * `${adminDir}/logs/HEAD` — never the full `enumerateRefs`/`listReflogs`
 * walk `addRefRoots`/`addReflogRoots` do for the CURRENT worktree — also
 * removes the redundant shared-commonDir re-walk a full walk would repeat
 * per worktree: only `adminDir`-rooted paths are ever touched here. Shared
 * by `addOtherWorktreeRoots` (each linked worktree) and `addMainWorktreeRoots`
 * (the main worktree, exactly as "non-current" as any other from a linked
 * worktree's perspective).
 */
async function addNonCurrentWorktreeRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  try {
    // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
    roots.add(await resolveRef(ctx, HEAD_REF, { peel: false }));
  } catch (err) {
    if (!isTolerableRefFault(err)) throw err;
    // Unborn/dangling/malformed HEAD — tolerated, same as addRefRoots.
  }
  addReflogEntryRoots(roots, await readReflogIfOpenable(ctx, HEAD_REF), zeroOid(ctx.hashConfig));
  await addIndexRetentionRoots(ctx, roots);
}

/** One index's gc roots: its entries and cache-tree, then every regular-file
 *  resolve-undo stage, as git's `add_resolve_undo_to_pending` adds them. */
async function addIndexRetentionRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const { resolveUndo } = await addIndexRoots(ctx, roots);
  for (const id of resolveUndo) roots.add(id);
}

/** Whether `ctx` IS the main worktree — its own `gitDir` doubles as the
 *  shared `commonDir` (no `worktrees/<id>` nesting). A linked worktree's
 *  `gitDir` is always `${commonDir}/worktrees/<id>`, so the two coincide
 *  only for the main worktree. */
function isMainWorktreeCtx(ctx: Context): boolean {
  return ctx.layout.gitDir === commonGitDir(ctx);
}

/**
 * Roots the MAIN worktree's own retention state (`addNonCurrentWorktreeRoots`
 * — HEAD, its own HEAD reflog, and its own index) — covered for free when
 * gc runs FROM the main worktree (`ctx` IS already that worktree, so
 * `collectRetentionRoots`'s own direct calls against `ctx` handle it), but
 * otherwise unreachable from anything else this module calls:
 * `addOtherWorktreeRoots` only enumerates `${commonDir}/worktrees/*`, a
 * registry the main worktree predates and is never a member of. Builds a
 * Context whose `gitDir` IS `commonDir` (the main worktree's own admin-dir
 * convention) via `deriveContext` rather than `deriveWorktreeContext` — the
 * latter always nests under `worktrees/<id>`, which is exactly the shape
 * the main worktree does NOT have; nothing this function calls reads
 * `ctx.layout.workDir`, so the parent's own value (irrelevant here) is left
 * untouched. `promisor`/`hooks`/`command` are dropped before deriving —
 * mirroring `deriveWorktreeContext` — since all three close over the
 * PARENT Context and would fire against the parent's gitdir if ever invoked
 * while `mainCtx` is in hand. `ctx.fs` needs no changes either: `commonDir`
 * is already inside its containment roots (every admin file this walk reads
 * already lives there for the CURRENT worktree's own shared reads). Pinned
 * against git 2.55.0: `git gc --prune=now` invoked from a linked worktree
 * still roots a commit reachable only from the main worktree's own detached
 * HEAD.
 */
async function addMainWorktreeRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  if (isMainWorktreeCtx(ctx)) return;
  await addNonCurrentWorktreeRoots(mainWorktreeContext(ctx), roots);
}

/** A Context rooted at the main worktree's own admin dir (`commonDir`). */
function mainWorktreeContext(ctx: Context): Context {
  const { promisor: _promisor, hooks: _hooks, command: _command, ...rest } = ctx;
  return deriveContext(rest, {
    layout: Object.freeze({ ...ctx.layout, gitDir: commonGitDir(ctx) }),
  });
}

/**
 * Roots every OTHER (linked) worktree registered under
 * `${commonGitDir}/worktrees/*` — the main worktree's own state is
 * `addMainWorktreeRoots`'s job, and whichever worktree `ctx` itself IS (its
 * own admin dir may itself be listed here) is skipped: covered already by
 * `collectRetentionRoots`'s direct calls against `ctx`, re-walking it here
 * would only be a wasted, redundant read. Pinned against git 2.55.0:
 * `git gc --prune=now` keeps an object reachable ONLY from a linked
 * worktree's own (possibly detached) HEAD — without this, gc would
 * cruft-then-destroy a subgraph another worktree is actively using. A
 * worktree whose `gitdir` is missing, unopenable or empty roots nothing, as
 * git's `get_linked_worktree` skips it.
 */
async function addOtherWorktreeRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const root = `${commonGitDir(ctx)}/worktrees`;
  if (!(await ctx.fs.exists(root))) return;
  for (const entry of await ctx.fs.readdir(root)) {
    if (!entry.isDirectory) continue;
    const adminDir = `${root}/${entry.name}`;
    if (adminDir === ctx.layout.gitDir) continue;
    const worktreeCtx = await linkedWorktreeContext(ctx, entry.name, adminDir);
    if (worktreeCtx !== undefined) await addNonCurrentWorktreeRoots(worktreeCtx, roots);
  }
}

/**
 * Retention roots for `maintenance`'s `gc` task: every resolvable
 * ref (HEAD included), every reflog old/new oid, the index — every
 * non-gitlink entry plus its cache-tree, when present — the MAIN worktree's own state
 * (`addMainWorktreeRoots`) and every OTHER worktree's own state
 * (`addOtherWorktreeRoots`), matching git rooting reachability across every
 * worktree regardless of which one gc is invoked from. Unlike `collectRoots`,
 * this takes no pre-built object universe: gc is discovering the
 * loose/cruft candidate set the reachability walk will need, not consuming
 * a finished enumeration, so a universe would be the wrong cost shape here.
 *
 * Every collector runs in STRICT mode (see `isTolerableRefFault`): a ref
 * that genuinely isn't one roots nothing, exactly as `collectRoots`
 * tolerates, and a reflog or worktree `gitdir` that cannot be opened is
 * absent, as git's own reads treat it (`isUnopenableFile`) — so what only it
 * named is pruned, as git prunes it. Any other fault rethrows and aborts the
 * run rather than silently rooting nothing — gc has no corruption report to
 * raise from a miss the way fsck does, so a swallowed fault here would
 * destroy a subgraph the caller never learns it lost.
 */
export async function collectRetentionRoots(ctx: Context): Promise<ReadonlySet<ObjectId>> {
  const roots = new Set<ObjectId>();
  await addRefRoots(ctx, roots, undefined, true);
  await addReflogRoots(ctx, roots);
  await addIndexRetentionRoots(ctx, roots);
  await addMainWorktreeRoots(ctx, roots);
  await addOtherWorktreeRoots(ctx, roots);
  return roots;
}

/** One worktree's HEAD as git's fsck snapshots it. */
export interface WorktreeHead {
  /** `HEAD` for the current worktree, else `main-worktree/HEAD` or `worktrees/<id>/HEAD`. */
  readonly ref: RefName;
  readonly id: ObjectId;
}

/** The object `worktreeCtx`'s HEAD names, or `undefined` when it names none. */
async function headOf(worktreeCtx: Context): Promise<ObjectId | undefined> {
  try {
    // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
    return await resolveRef(worktreeCtx, HEAD_REF, { peel: false });
  } catch (err) {
    if (!isTolerableRefFault(err)) throw err;
    return undefined;
  }
}

/** A linked worktree's Context, or `undefined` when its `gitdir` file is
 *  missing, unreadable or empty — git's `get_linked_worktree` skips it then. */
async function linkedWorktreeContext(
  ctx: Context,
  id: string,
  adminDir: string,
): Promise<Context | undefined> {
  if (adminDir === ctx.layout.gitDir) return ctx;
  let pointer: string;
  try {
    pointer = (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).trim();
  } catch (err) {
    if (isUnopenableFile(err)) return undefined;
    throw err;
  }
  if (pointer === '') return undefined;
  return deriveWorktreeContext(ctx, id, stripGitSuffix(resolveWorktreePath(adminDir, pointer)));
}

/** git's `get_worktrees` order: the main worktree, then each admin entry as listed. */
async function worktreeContexts(
  ctx: Context,
): Promise<ReadonlyArray<{ readonly ref: RefName; readonly worktreeCtx: Context }>> {
  const main = isMainWorktreeCtx(ctx) ? ctx : mainWorktreeContext(ctx);
  const all = [{ ref: refFor(ctx, main, 'main-worktree/HEAD'), worktreeCtx: main }];
  const root = `${commonGitDir(ctx)}/worktrees`;
  if (!(await ctx.fs.exists(root))) return all;
  for (const entry of await ctx.fs.readdir(root)) {
    const worktreeCtx = await linkedWorktreeContext(ctx, entry.name, `${root}/${entry.name}`);
    if (worktreeCtx === undefined) continue;
    all.push({ ref: refFor(ctx, worktreeCtx, `worktrees/${entry.name}/HEAD`), worktreeCtx });
  }
  return all;
}

const refFor = (ctx: Context, worktreeCtx: Context, foreign: string): RefName =>
  (worktreeCtx === ctx ? HEAD_REF : foreign) as RefName;

/**
 * Every worktree's HEAD that names an object — git's `snapshot_refs` worktree
 * loop: the current one as `HEAD`, the others under their per-worktree
 * prefix. A HEAD naming nothing (unborn, unresolvable) is skipped as git's
 * `refs_resolve_ref_unsafe` returning NULL is.
 */
export async function worktreeHeads(ctx: Context): Promise<ReadonlyArray<WorktreeHead>> {
  const heads: WorktreeHead[] = [];
  for (const { ref, worktreeCtx } of await worktreeContexts(ctx)) {
    const id = await headOf(worktreeCtx);
    if (id !== undefined) heads.push({ ref, id });
  }
  return heads;
}

import { TsgitError } from '../../../../domain/error.js';
import type { CacheTreeEntry, GitIndex } from '../../../../domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../domain/git-index/index-parser.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { zeroOid } from '../../../../domain/objects/index.js';
import { resolveWorktreePath } from '../../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { boundedMapFor } from '../../../primitives/internal/concurrency.js';
import { errorDataCode } from '../../../primitives/internal/error-data-code.js';
import { deriveWorktreeContext } from '../../../primitives/internal/worktree-context.js';
import { commonGitDir } from '../../../primitives/path-layout.js';
import { readIndex } from '../../../primitives/read-index.js';
import { listReflogs, readReflog } from '../../../primitives/reflog-store.js';
import { resolveRef } from '../../../primitives/resolve-ref.js';
import { objectIsPresent } from './object-presence.js';
import type { FsckOptions } from './types.js';

const CACHE_TREE_SIGNATURE = 'TREE';

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
function isContainedLookupFault(err: unknown): boolean {
  if (!(err instanceof TsgitError) || err.data.code !== 'INVALID_MULTI_PACK_INDEX') return false;
  return err.data.check === 'pack-int-id' || err.data.check === 'large-offset';
}

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
 * Add every resolvable ref's target to `roots`. Returns whether any ref
 * resolved to an oid ABSENT from the universe — git probes such a target
 * against the promisor machinery (`is_promisor_object`), so the caller's
 * promisor-config gate must fire for it even though it roots nothing.
 *
 * `universe` is optional: omitted, every resolved ref target is added
 * unconditionally and the "absent target" verdict never fires — the shape
 * `collectRetentionRoots` needs (gc has no pre-built object universe to
 * bound against; unlike `collectRoots`, it never reports corruption).
 */
async function addRefRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe?: ReadonlySet<ObjectId>,
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
    } catch {
      // Unresolvable ref (unborn, dangling symref, malformed content) — tolerated
    }
  }
  return sawAbsentTarget;
}

async function addReflogRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const reflogNames = await listReflogs(ctx);
  const zero = zeroOid(ctx.hashConfig);
  await boundedMapFor(ctx, 'ioBound', reflogNames, async (ref) => {
    try {
      const entries = await readReflog(ctx, ref);
      for (const entry of entries) {
        // The zero oid is the "no object" sentinel git writes for creation
        // events (first reflog entry of any ref). It is not a real object
        // reference and must never be treated as a reachability root.
        if (entry.oldId !== zero) roots.add(entry.oldId);
        if (entry.newId !== zero) roots.add(entry.newId);
      }
    } catch {
      // Unreadable reflog — tolerated
    }
  });
}

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
  universe?: ReadonlySet<ObjectId>,
): Promise<boolean> {
  const stack: CacheTreeEntry[] = [root];
  let unresolved = false;
  while (stack.length > 0) {
    const entry = stack.pop() as CacheTreeEntry;
    if (entry.id !== undefined) {
      const present = await probePresence(ctx, entry.id);
      if (present === false) {
        unresolved = true;
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
    }
    for (const child of entry.children) stack.push(child);
  }
  return unresolved;
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

/**
 * Add every stage-0 index entry's oid to `roots`, then walk the index's
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
): Promise<boolean> {
  const index = await readIndexIfIntact(ctx);
  if (index === undefined) return false;
  for (const entry of index.entries) {
    if (entry.flags.stage !== 0) continue;
    roots.add(entry.id);
  }
  const cacheTree = cacheTreeOf(ctx, index);
  if (cacheTree === undefined) return false;
  return walkCacheTree(ctx, cacheTree, roots, universe);
}

export interface RootsCollection {
  readonly roots: ReadonlySet<ObjectId>;
  /**
   * The repository-wide condition `fsck`'s missing-entry-point rule (bit 8)
   * fires on: the index carries a cache-tree (`TREE` extension) AND at
   * least one of its entries' tree oids fails to resolve. No index, or an
   * index with no cache-tree extension, never sets this — vacuous absence
   * is not a fault. Ref and reflog resolution have no bearing on this bit.
   */
  readonly missingEntryPoint: boolean;
  /**
   * A ref resolved to an oid absent from the universe. git's fsck probes
   * that target through the promisor machinery, which is what makes the
   * promisor-config gate fire on a repo whose ONLY ref is broken.
   */
  readonly sawAbsentRefTarget: boolean;
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
): Promise<RootsCollection> {
  const roots = new Set<ObjectId>();
  const sawAbsentRefTarget = await addRefRoots(ctx, roots, universe);
  if (opts.reflogRoots !== false) await addReflogRoots(ctx, roots);
  const missingEntryPoint =
    opts.indexRoot !== false ? await addIndexRoots(ctx, roots, universe) : false;
  return { roots, missingEntryPoint, sawAbsentRefTarget };
}

/** Strip a trailing `/.git` from `dir`; absent means `dir` itself — the same
 *  "gitdir file to working-tree path" rule `listWorktrees` uses. */
const GIT_SUFFIX = '/.git';
const stripGitSuffix = (dir: string): string =>
  dir.endsWith(GIT_SUFFIX) ? dir.slice(0, -GIT_SUFFIX.length) : dir;

function isMissingGitdirFile(error: unknown): boolean {
  return errorDataCode(error) === 'FILE_NOT_FOUND';
}

/**
 * Roots one linked worktree's own retention state: its HEAD, its
 * per-worktree refs (`refs/bisect/…`, `refs/worktree/…`, `refs/rewritten/…`
 * — whatever `enumerateRefs` resolves through that worktree's own admin
 * dir), and its own index — git's `other_head_refs()` plus a per-worktree
 * index walk. A worktree whose `gitdir` pointer is gone (prunable, `git
 * worktree prune`'s job, not gc's) contributes nothing.
 */
async function addOneWorktreeRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  id: string,
  adminDir: string,
): Promise<void> {
  let gitdirPointer: string;
  try {
    gitdirPointer = resolveWorktreePath(
      adminDir,
      (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).trim(),
    );
  } catch (err) {
    if (isMissingGitdirFile(err)) return;
    throw err;
  }
  const worktreePath = stripGitSuffix(gitdirPointer);
  const worktreeCtx = deriveWorktreeContext(ctx, id, worktreePath);
  await addRefRoots(worktreeCtx, roots);
  await addIndexRoots(worktreeCtx, roots);
}

/**
 * Roots every OTHER (linked) worktree registered under
 * `${commonGitDir}/worktrees/*` — the main worktree's own HEAD/refs/index
 * are already covered by `collectRetentionRoots`'s own calls against `ctx`
 * itself. Pinned against git 2.55.0: `git gc --prune=now` keeps an object
 * reachable ONLY from a linked worktree's own (possibly detached) HEAD —
 * without this, gc would cruft-then-destroy a subgraph another worktree is
 * actively using.
 */
async function addOtherWorktreeRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const root = `${commonGitDir(ctx)}/worktrees`;
  if (!(await ctx.fs.exists(root))) return;
  for (const entry of await ctx.fs.readdir(root)) {
    if (!entry.isDirectory) continue;
    await addOneWorktreeRoots(ctx, roots, entry.name, `${root}/${entry.name}`);
  }
}

/**
 * Retention roots for `maintenance`'s `gc` task (Pin H): every resolvable
 * ref (HEAD included), every reflog old/new oid, the index — stage-0
 * entries plus its cache-tree, when present — and every OTHER worktree's
 * own HEAD, per-worktree refs and index (`addOtherWorktreeRoots`), matching
 * git rooting reachability across every worktree, not just the one gc is
 * invoked from. Unlike `collectRoots`, this takes no pre-built object
 * universe: gc is discovering the loose/cruft candidate set the
 * reachability walk will need, not consuming a finished enumeration, so a
 * universe would be the wrong cost shape here. Every collector runs
 * unbounded — an unresolvable ref, cache-tree entry or reflog simply roots
 * nothing, the same tolerance `collectRoots`'s own try/catch blocks already
 * apply; gc has nothing analogous to fsck's corruption report to raise
 * from a miss.
 */
export async function collectRetentionRoots(ctx: Context): Promise<ReadonlySet<ObjectId>> {
  const roots = new Set<ObjectId>();
  await addRefRoots(ctx, roots);
  await addReflogRoots(ctx, roots);
  await addIndexRoots(ctx, roots);
  await addOtherWorktreeRoots(ctx, roots);
  return roots;
}

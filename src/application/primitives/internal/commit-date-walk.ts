import { BinaryHeap } from '../../../domain/commit/binary-heap.js';
import { precedes, type QueueEntry } from '../../../domain/commit/priority-queue.js';
import { operationAborted } from '../../../domain/error.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type BoundedReader, createBoundedReader } from './bounded-reader.js';
import { limitFor } from './concurrency.js';
import { readCommit } from './read-commit.js';
import { commitHeader } from './read-commit-graph.js';
import { resolveShallow } from './shallow-set.js';

type CommitBodies = BoundedReader<Commit | undefined>;

/**
 * One walk step: the popped commit plus the frontier state sampled after the
 * pop and before its parents are enqueued (git describe cond-2 check point).
 */
export type DateWalkStep = {
  readonly commit: Commit;
  readonly frontierEmpty: boolean;
  /** Lazy snapshot of the queued oids; valid until the iterator resumes. */
  readonly frontier: () => ReadonlyArray<ObjectId>;
};

/** Parents this walk follows: the first parent only, or all of them. */
export const selectParents = (commit: Commit, firstParent: boolean): ReadonlyArray<ObjectId> =>
  firstParent ? commit.data.parents.slice(0, 1) : commit.data.parents;

export interface CommitDateWalkOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  /**
   * Boundary override. Omitted ⇒ the repository's `.git/shallow` set is
   * loaded automatically (once per `Context`); supplied — including an
   * explicit empty `Set` — ⇒ the caller's set governs which commits are
   * masked. A boundary commit is still yielded with `parents: []`; only its
   * parents are skipped.
   */
  readonly shallow?: ReadonlySet<ObjectId>;
  /** Follow only the first parent through merges (git's `--first-parent`). */
  readonly firstParent?: boolean;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
}

/** Mutable state threaded through the date-ordered walk. */
interface DateWalk {
  readonly heap: BinaryHeap<QueueEntry<Promise<Commit | undefined>>>;
  readonly seen: Set<ObjectId>;
  readonly until: Set<ObjectId>;
  readonly firstParent: boolean;
  readonly bodies: CommitBodies;
  readonly ignoreMissing: boolean;
}

/**
 * The shared date-priority commit traversal: walk every commit reachable from
 * `from` (across all parents, or first-parent only) in commit-date priority
 * order — newest committer date first, oid-ascending on ties (the shared
 * `domain/commit` comparator). A commit's date is sourced from the
 * commit-graph when available (no I/O beyond the first parse), which lets its
 * heap entry — and its parents' — get pushed without waiting on a full object
 * read; the read itself is deferred to a bounded, deduped prefetcher and
 * awaited only when the entry is popped. Commits absent from the graph fall
 * back to reading eagerly, exactly as before.
 *
 * A `seen` set guards enqueue, so each reachable commit is read and yielded at
 * most once and the frontier is bounded by the reachable-commit count. `until`
 * excludes commits before they are read; `shallow` boundaries are yielded but
 * their parents are not walked; `ignoreMissing` / `verifyHash` thread into the
 * shared commit reader; an aborted signal throws at the next loop head.
 *
 * Seeds are assumed already resolved and within bounds — the public
 * `walkCommitsByDate` wrapper owns the `INVALID_WALK_INPUT` seed contract.
 *
 * The walk is lazy (parents discovered on pop), so it matches
 * `git rev-list --date-order` for histories whose committer dates are monotonic
 * along parent edges — every history built by normal git operations. It does not
 * enforce git's strict all-children-before-parent rule for forged reverse-causal
 * dates, trading that edge case for streaming composition.
 */
export async function* commitDateWalk(
  ctx: Context,
  options: CommitDateWalkOptions,
): AsyncIterable<DateWalkStep> {
  const shallow = await resolveShallow(ctx, options.shallow);
  const verifyHash = options.verifyHash ?? false;
  const ignoreMissing = options.ignoreMissing ?? false;
  // `seen` already prevents any re-read, so the reader's missing-memo is inert
  // here; it satisfies the shared contract without a second set.
  const missing = new Set<string>();
  const bound = limitFor(ctx, 'ioBound');
  const walk: DateWalk = {
    heap: new BinaryHeap<QueueEntry<Promise<Commit | undefined>>>(precedes),
    seen: new Set<ObjectId>(options.from),
    until: new Set<ObjectId>(options.until ?? []),
    firstParent: options.firstParent ?? false,
    bodies: createBoundedReader(bound, (id) =>
      readCommit(ctx, id, { verifyHash, ignoreMissing, missing, shallow }),
    ),
    ignoreMissing,
  };

  await enqueueSeeds(ctx, walk);

  while (walk.heap.size() > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    const { oid, value: bodyPromise } = walk.heap.pop() as QueueEntry<Promise<Commit | undefined>>;
    const commit = await bodyPromise;
    // Consumed: drop the memo entry (`seen` already blocks re-enqueue), or a
    // full-history drain retains every body simultaneously.
    walk.bodies.forget(oid);
    if (commit === undefined) continue;
    yield {
      commit,
      frontierEmpty: walk.heap.size() === 0,
      frontier: () => walk.heap.entries().map((entry) => entry.oid),
    };
    if (shallow.has(commit.id)) continue;
    await enqueueParents(ctx, walk, commit);
  }
}

type HeapEntry = QueueEntry<Promise<Commit | undefined>>;

// Iterate the deduped `seen` set, not raw `from`, so a duplicate seed enqueues
// once — the pop loop has no visited check by design.
const enqueueSeeds = async (ctx: Context, walk: DateWalk): Promise<void> => {
  for (const seed of walk.seen) {
    if (walk.until.has(seed)) continue;
    await enqueueCommit(ctx, walk, seed);
  }
};

/**
 * Every selected parent is resolved concurrently (each one's date comes from
 * the commit-graph, with no body await, or from its own body), but pushed
 * onto the heap only once ALL of them have settled — and in parent-array
 * order, not completion order. `entries()` returns the heap's backing array
 * by reference, so sibling push order becomes observable frontier order; a
 * naive "push as each resolves" fan-out would leak completion timing into
 * it. Rejections likewise rethrow in array order, not first-in-time —
 * `Promise.allSettled` already waited for every read.
 */
const enqueueParents = async (ctx: Context, walk: DateWalk, commit: Commit): Promise<void> => {
  const parents = selectParents(commit, walk.firstParent).filter((parent) => {
    if (walk.seen.has(parent) || walk.until.has(parent)) return false;
    walk.seen.add(parent);
    return true;
  });
  const settled = await Promise.allSettled(
    parents.map((parent) => resolveHeapEntry(ctx, walk, parent)),
  );
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
  }
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value !== undefined) {
      walk.heap.push(result.value);
    }
  }
};

const enqueueCommit = async (ctx: Context, walk: DateWalk, id: ObjectId): Promise<void> => {
  const entry = await resolveHeapEntry(ctx, walk, id);
  if (entry !== undefined) {
    walk.heap.push(entry);
  }
};

const resolveHeapEntry = async (
  ctx: Context,
  walk: DateWalk,
  id: ObjectId,
): Promise<HeapEntry | undefined> => {
  const header = await commitHeader(ctx, id);
  const bodyPromise = walk.bodies.start(id);
  if (header !== undefined && !walk.ignoreMissing) {
    // Graph-confirmed: the date is known without awaiting the body, so
    // resolving (and any downstream enqueue it enables) does not wait on
    // I/O. (A missing body without `ignoreMissing` rejects at pop and aborts
    // the walk, so resolving early is unobservable.)
    return { oid: id, date: header.committerDate, value: bodyPromise };
  }
  // Graph-absent fallback — and, under `ignoreMissing`, the stale-graph
  // guard: a commit whose body is gone must never enter the heap (it would
  // leak into `frontierEmpty`/`frontier()` snapshots the old walk never saw).
  const commit = await bodyPromise;
  if (commit === undefined) return undefined;
  const date = header?.committerDate ?? commit.data.committer.timestamp;
  return { oid: id, date, value: bodyPromise };
};

import type { BisectCandidate } from '../../domain/bisect/index.js';
import { estimateSteps, findBisection } from '../../domain/bisect/index.js';
import { BinaryHeap } from '../../domain/commit/binary-heap.js';
import { invalidWalkInput } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import type { BisectMidpoint } from './types.js';

type CommitEntry = {
  readonly date: number;
  readonly parents: ReadonlyArray<ObjectId>;
};

const readCommitEntry = async (ctx: Context, id: ObjectId): Promise<CommitEntry> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw invalidWalkInput(`bisectMidpoint: ${id} is not a commit`);
  return { date: obj.data.committer.timestamp, parents: obj.data.parents };
};

/**
 * BFS-paint all commits reachable from `roots` into a Map.
 * Uses an index-pointer cursor (O(N) traversal; no queue.shift()).
 */
const paintReachable = async (
  ctx: Context,
  roots: ReadonlyArray<ObjectId>,
): Promise<Map<ObjectId, CommitEntry>> => {
  const visited = new Map<ObjectId, CommitEntry>();
  const queue: ObjectId[] = [...roots];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    // Stryker disable next-line ConditionalExpression: equivalent — Map.set is idempotent, so re-popping an already-visited id rewrites the identical entry; the finite acyclic DAG bounds total pops, leaving termination and the final Map unchanged.
    if (visited.has(id)) continue;
    const entry = await readCommitEntry(ctx, id);
    visited.set(id, entry);
    for (const parent of entry.parents) {
      // Stryker disable next-line ConditionalExpression: equivalent — pushing an already-visited parent only adds a pop the has-check above skips, so no node is re-expanded and the final Map is identical.
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return visited;
};

type WalkNode = {
  readonly id: ObjectId;
  readonly date: number;
  readonly parents: ReadonlyArray<ObjectId>;
};

/** Per-walk memoizing commit reader (each commit is read at most once). */
const makeEntryReader = (ctx: Context): ((id: ObjectId) => Promise<CommitEntry>) => {
  const cache = new Map<ObjectId, CommitEntry>();
  return async (id) => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const entry = await readCommitEntry(ctx, id);
    cache.set(id, entry);
    return entry;
  };
};

/**
 * Walk from `bad` in git's faithful rev-list order — FIFO-stable
 * priority-queue (newest-first, equal-date FIFO), parents enumerated
 * first-parent-first — skipping UNINTERESTING (good-reachable) commits.
 * Returns the visited commits newest-first.
 */
type HeapEntry = { readonly id: ObjectId; readonly date: number; readonly ins: number };

// FIFO-stable tie-break: smaller `ins` (earlier insertion) = higher priority. This
// replicates git's `prio_queue` insertion-counter tie-break, the only ordering
// faithful to `do_find_bisection`'s list-order tie-break.
const less = (a: HeapEntry, b: HeapEntry): boolean =>
  a.date > b.date ||
  (a.date === b.date &&
    // Stryker disable next-line EqualityOperator: equivalent — `ins` is assigned by a per-walk `ins++` counter, so every heap entry holds a unique value and no two coexisting entries share an `ins`; `<=` therefore returns true on exactly the same distinct pairs as `<`.
    a.ins < b.ins);

const walkCandidatesNewestFirst = async (
  getEntry: (id: ObjectId) => Promise<CommitEntry>,
  bad: ObjectId,
  badDate: number,
  goodReachable: ReadonlyMap<ObjectId, CommitEntry>,
): Promise<ReadonlyArray<WalkNode>> => {
  let ins = 0;
  const visited = new Set<ObjectId>();
  const newestFirst: WalkNode[] = [];
  const heap = new BinaryHeap<HeapEntry>(less);
  // Stryker disable next-line UpdateOperator: equivalent — post-fix `ins--` still assigns 0 to bad, and bad is popped before any parent is pushed so its `ins` never enters a `less` comparison; the shift it leaves on the counter is uniform across every later `ins++`, preserving all relative tie-breaks.
  heap.push({ id: bad, date: badDate, ins: ins++ });

  while (heap.size() > 0) {
    const { id } = heap.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const entry = await getEntry(id);
    newestFirst.push({ id, date: entry.date, parents: entry.parents });
    for (const parent of entry.parents) {
      if (visited.has(parent) || goodReachable.has(parent)) continue;
      const pe = await getEntry(parent);
      heap.push({ id: parent, date: pe.date, ins: ins++ });
    }
  }
  return newestFirst;
};

/** Reverse to oldest-first and keep only in-set parents (git's `limit_list` projection). */
const projectOldestFirst = (
  newestFirst: ReadonlyArray<WalkNode>,
): ReadonlyArray<BisectCandidate> => {
  const inSet = new Set<ObjectId>();
  for (const node of newestFirst) inSet.add(node.id);
  return newestFirst
    .slice()
    .reverse()
    .map((node) => ({
      id: node.id,
      parents: node.parents.filter((p) => inSet.has(p)),
      date: node.date,
    }));
};

/**
 * Collect commits reachable from `bad` that are NOT in `goodReachable`, in
 * git's faithful rev-list order (oldest-first), matching `do_find_bisection`'s
 * expected input order.
 */
const collectCandidatesOldestFirst = async (
  ctx: Context,
  bad: ObjectId,
  goodReachable: ReadonlyMap<ObjectId, CommitEntry>,
): Promise<ReadonlyArray<BisectCandidate>> => {
  const getEntry = makeEntryReader(ctx);
  const badEntry = await getEntry(bad); // throws if bad is not a commit
  if (goodReachable.has(bad)) return [];
  const newestFirst = await walkCandidatesNewestFirst(getEntry, bad, badEntry.date, goodReachable);
  return projectOldestFirst(newestFirst);
};

const deriveMidpoint = (
  bisection: NonNullable<ReturnType<typeof findBisection>>,
): BisectMidpoint => ({
  nextCommit: bisection.nextCommit,
  candidateCount: bisection.candidateCount,
  remainingIfGood: bisection.candidateCount - bisection.reaches - 1,
  remainingIfBad: bisection.reaches - 1,
  remainingSteps: estimateSteps(bisection.candidateCount),
});

/**
 * Compute the bisect midpoint: the commit that halves the candidate set
 * (commits reachable from `bad` but not from any `good`).
 *
 * Returns `undefined` when the candidate set is empty (the bug does not
 * exist within the `good`→`bad` range, or `bad` is already `good`-reachable).
 *
 * Mirrors `git rev-list --bisect-vars` semantics; see `BisectMidpoint`.
 */
export const bisectMidpoint = async (
  ctx: Context,
  good: ReadonlyArray<ObjectId>,
  bad: ObjectId,
): Promise<BisectMidpoint | undefined> => {
  const goodReachable = await paintReachable(ctx, good);
  const candidates = await collectCandidatesOldestFirst(ctx, bad, goodReachable);
  const bisection = findBisection(candidates);
  return bisection === undefined ? undefined : deriveMidpoint(bisection);
};

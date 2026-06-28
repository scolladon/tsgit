import type { BisectCandidate } from '../../domain/bisect/index.js';
import { estimateSteps, findBisection } from '../../domain/bisect/index.js';
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
    if (visited.has(id)) continue;
    const entry = await readCommitEntry(ctx, id);
    visited.set(id, entry);
    for (const parent of entry.parents) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return visited;
};

/**
 * FIFO-stable priority-queue entry for the bisect candidate walk.
 * Equal-date tie-break: smaller `ins` (earlier insertion) = higher priority → FIFO.
 * This replicates git's `prio_queue` insertion-counter tie-break, which is the
 * only ordering faithful to `do_find_bisection`'s list-order tie-break.
 * The shared `priority-queue.ts` uses oid as the tie-break (faithful for
 * order-independent consumers like merge-base/blame) and must NOT be changed.
 */
type WalkEntry = { readonly id: ObjectId; readonly date: number; readonly ins: number };

const entryPrecedes = (a: WalkEntry, b: WalkEntry): boolean =>
  a.date > b.date || (a.date === b.date && a.ins < b.ins);

const enqueueWalkEntry = (queue: WalkEntry[], entry: WalkEntry): void => {
  let i = 0;
  while (i < queue.length && !entryPrecedes(entry, queue[i]!)) i += 1;
  queue.splice(i, 0, entry);
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
const walkCandidatesNewestFirst = async (
  getEntry: (id: ObjectId) => Promise<CommitEntry>,
  bad: ObjectId,
  badDate: number,
  goodReachable: ReadonlyMap<ObjectId, CommitEntry>,
): Promise<ReadonlyArray<WalkNode>> => {
  let ins = 0;
  const visited = new Set<ObjectId>();
  const newestFirst: WalkNode[] = [];
  const walkQueue: WalkEntry[] = [];
  enqueueWalkEntry(walkQueue, { id: bad, date: badDate, ins: ins++ });

  while (walkQueue.length > 0) {
    const { id } = walkQueue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const entry = await getEntry(id);
    newestFirst.push({ id, date: entry.date, parents: entry.parents });
    for (const parent of entry.parents) {
      if (visited.has(parent) || goodReachable.has(parent)) continue;
      const pe = await getEntry(parent);
      enqueueWalkEntry(walkQueue, { id: parent, date: pe.date, ins: ins++ });
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

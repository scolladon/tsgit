import type { BisectCandidate } from '../../domain/bisect/index.js';
import { estimateSteps, findBisection } from '../../domain/bisect/index.js';
import { invalidWalkInput } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import type { BisectMidpoint } from './types.js';

/** Hard cap: prevents unbounded heap growth on degenerate histories. */
export const MAX_BISECT_CANDIDATES = 1_000_000;

type CommitEntry = {
  readonly date: number;
  readonly parents: ReadonlyArray<ObjectId>;
};

const readCommitEntry = async (ctx: Context, id: ObjectId): Promise<CommitEntry> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw invalidWalkInput(`bisectMidpoint: ${id} is not a commit`);
  return { date: obj.data.committer.timestamp, parents: obj.data.parents };
};

const paintReachable = async (
  ctx: Context,
  roots: ReadonlyArray<ObjectId>,
): Promise<Map<ObjectId, CommitEntry>> => {
  const visited = new Map<ObjectId, CommitEntry>();
  const queue: ObjectId[] = [...roots];
  for (;;) {
    const id = queue.shift();
    if (id === undefined) break;
    if (visited.has(id)) continue;
    const entry = await readCommitEntry(ctx, id);
    visited.set(id, entry);
    for (const parent of entry.parents) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return visited;
};

const byDateAsc = (a: ObjectId, b: ObjectId, map: ReadonlyMap<ObjectId, CommitEntry>): number => {
  const diff = (map.get(a)?.date ?? 0) - (map.get(b)?.date ?? 0);
  if (diff !== 0) return diff;
  return a < b ? -1 : a > b ? 1 : 0;
};

const buildCandidates = (
  badReachable: Map<ObjectId, CommitEntry>,
  goodReachable: ReadonlySet<ObjectId>,
): ReadonlyArray<BisectCandidate> => {
  const ids = [...badReachable.keys()].filter((id) => !goodReachable.has(id));
  if (ids.length > MAX_BISECT_CANDIDATES) {
    throw invalidWalkInput(
      `bisectMidpoint: candidate count ${ids.length} exceeds MAX_BISECT_CANDIDATES`,
    );
  }
  ids.sort((a, b) => byDateAsc(a, b, badReachable));
  const inSet = new Set(ids);
  return ids.map((id) => ({
    id,
    parents: (badReachable.get(id)?.parents ?? []).filter((p) => inSet.has(p)),
    date: badReachable.get(id)?.date ?? 0,
  }));
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
  const [badReachable, goodReachable] = await Promise.all([
    paintReachable(ctx, [bad]),
    paintReachable(ctx, good),
  ]);
  const candidates = buildCandidates(badReachable, new Set(goodReachable.keys()));
  const bisection = findBisection(candidates);
  return bisection === undefined ? undefined : deriveMidpoint(bisection);
};

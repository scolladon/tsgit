import { invalidWalkInput } from '../../domain/error.js';
import type { Commit } from '../../domain/objects/index.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;
const BOTH = PARENT1 | PARENT2;

export interface MergeBaseOptions {
  readonly all?: boolean;
  readonly octopus?: boolean;
}

type ReadCommit = (id: ObjectId) => Promise<Commit | undefined>;
interface QueueEntry {
  readonly id: ObjectId;
  readonly date: number;
}

const makeReadCommit = (ctx: Context): ReadCommit => {
  const cache = new Map<ObjectId, Commit | undefined>();
  return async (id) => {
    if (!cache.has(id)) {
      const obj = await readObject(ctx, id);
      cache.set(id, obj.type === 'commit' ? obj : undefined);
    }
    return cache.get(id);
  };
};

const dateOf = (commit: Commit | undefined): number => commit?.data.committer.timestamp ?? 0;

// Priority queue as an insertion-sorted array: front = newest date, oid asc on ties.
const precedes = (a: QueueEntry, b: QueueEntry): boolean =>
  a.date > b.date || (a.date === b.date && a.id < b.id);

const enqueue = (queue: QueueEntry[], entry: QueueEntry): void => {
  let i = 0;
  while (i < queue.length && !precedes(entry, queue[i]!)) i += 1;
  queue.splice(i, 0, entry);
};

const hasNonStale = (queue: readonly QueueEntry[], flags: ReadonlyMap<ObjectId, number>): boolean =>
  queue.some((entry) => ((flags.get(entry.id) ?? 0) & STALE) === 0);

/**
 * Paint commits down to their common ancestors (Git's `paint_down_to_common`).
 * `one` carries PARENT1, every `twos` carries PARENT2; a commit reached by both
 * is flagged RESULT, and STALE propagates from it to prune deeper ancestors.
 * Returns the per-call flag map; isolated state, so no mark-clearing is needed.
 */
const paint = async (
  read: ReadCommit,
  one: ObjectId,
  twos: readonly ObjectId[],
): Promise<Map<ObjectId, number>> => {
  const flags = new Map<ObjectId, number>();
  const queue: QueueEntry[] = [];
  const mark = async (id: ObjectId, bits: number): Promise<void> => {
    flags.set(id, (flags.get(id) ?? 0) | bits);
    enqueue(queue, { id, date: dateOf(await read(id)) });
  };
  await mark(one, PARENT1);
  for (const two of twos) await mark(two, PARENT2);
  while (hasNonStale(queue, flags)) {
    const { id } = queue.shift()!;
    let f = (flags.get(id) ?? 0) & (BOTH | STALE);
    if (f === BOTH) {
      flags.set(id, (flags.get(id) ?? 0) | RESULT);
      f |= STALE;
    }
    const commit = await read(id);
    for (const parent of commit?.data.parents ?? []) {
      if (((flags.get(parent) ?? 0) & f) === f) continue;
      await mark(parent, f);
    }
  }
  return flags;
};

const collectResults = (flags: ReadonlyMap<ObjectId, number>): ObjectId[] => {
  const out: ObjectId[] = [];
  for (const [id, f] of flags) if ((f & RESULT) !== 0) out.push(id);
  return out;
};

/**
 * Drop commits reachable from another in the set (Git's `remove_redundant`).
 * A candidate is redundant iff it is an ancestor of another: painting it as
 * PARENT1 against the rest as PARENT2, it picks up PARENT2 exactly when some
 * other commit reaches down to it.
 */
const removeRedundant = async (
  read: ReadCommit,
  commits: readonly ObjectId[],
): Promise<ObjectId[]> => {
  const unique = [...new Set(commits)];
  if (unique.length <= 1) return unique;
  const kept: ObjectId[] = [];
  for (const candidate of unique) {
    const others = unique.filter((o) => o !== candidate);
    const flags = await paint(read, candidate, others);
    if (((flags.get(candidate) ?? 0) & PARENT2) === 0) kept.push(candidate);
  }
  return kept;
};

const mergeBasesMany = async (
  read: ReadCommit,
  one: ObjectId,
  twos: readonly ObjectId[],
): Promise<ObjectId[]> => {
  if (twos.length === 0) return [one];
  const results = collectResults(await paint(read, one, twos));
  return removeRedundant(read, results);
};

const octopusMergeBases = async (
  read: ReadCommit,
  commits: readonly ObjectId[],
): Promise<ObjectId[]> => {
  let acc: ObjectId[] = [commits[0]!];
  for (let i = 1; i < commits.length; i += 1) {
    const next: ObjectId[] = [];
    for (const base of acc) next.push(...(await mergeBasesMany(read, commits[i]!, [base])));
    acc = next;
  }
  return removeRedundant(read, acc);
};

/**
 * Compute merge bases — the best common ancestors of the given commits.
 *
 * `commits[0]` is `one`, the rest are the others. Returns the lexicographically
 * smallest single base by default; the full reduced set with `{ all: true }`;
 * the octopus fold with `{ octopus: true }`. Unrelated histories yield `[]`.
 */
export const mergeBase = async (
  ctx: Context,
  commits: readonly ObjectId[],
  options?: MergeBaseOptions,
): Promise<readonly ObjectId[]> => {
  if (commits.length === 0) throw invalidWalkInput('mergeBase requires at least one commit');
  const read = makeReadCommit(ctx);
  const bases = options?.octopus
    ? await octopusMergeBases(read, commits)
    : await mergeBasesMany(read, commits[0]!, commits.slice(1));
  const sorted = [...bases].sort();
  return options?.all === true ? sorted : sorted.slice(0, 1);
};

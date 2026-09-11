import { BinaryHeap } from '../../domain/commit/binary-heap.js';
import type { QueueEntry } from '../../domain/commit/priority-queue.js';
import { invalidWalkInput } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import {
  type CommitMeta,
  GENERATION_INFINITY,
  readCommitMeta,
} from './internal/read-commit-meta.js';

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;
const BOTH = PARENT1 | PARENT2;

export interface MergeBaseOptions {
  readonly all?: boolean;
  readonly octopus?: boolean;
}

type ReadCommit = (id: ObjectId) => Promise<CommitMeta | undefined>;

const makeReadCommit = (ctx: Context): ReadCommit => {
  const cache = new Map<ObjectId, CommitMeta | undefined>();
  return async (id) => {
    // Stryker disable next-line all: equivalent — the cache is a pure memoisation
    // over `readCommitMeta`'s deterministic read; forcing a miss only re-invokes
    // it and re-derives the identical metadata, never changing a result (the
    // forced-hit direction returns `undefined` and is killed by every
    // commit-resolving test).
    if (!cache.has(id)) cache.set(id, await readCommitMeta(ctx, id));
    return cache.get(id);
  };
};

const dateOf = (meta: CommitMeta | undefined): number => meta?.committerDate ?? 0;

/** A commit the graph does not cover sorts as infinitely young, so it can
 *  never trip the `minGeneration` break (Git's `GENERATION_NUMBER_INFINITY`). */
const generationOf = (meta: CommitMeta | undefined): number =>
  meta?.generation ?? GENERATION_INFINITY;

const hasNonStale = (
  queue: readonly QueueEntry<undefined>[],
  flags: ReadonlyMap<ObjectId, number>,
): boolean =>
  // Stryker disable next-line all: equivalent — forcing this true only drains the
  // whole queue instead of stopping early; the extra stale pops re-mark nothing
  // (parents already carry their flags), so RESULT bits and the output are identical.
  queue.some((entry) => ((flags.get(entry.oid) ?? 0) & STALE) === 0);

interface PaintEntry extends QueueEntry<undefined> {
  readonly generation: number;
  /** Git's `prio_queue` insertion counter: on a generation-and-date tie, the
   *  entry queued first wins — `one` before `twos`, a parent the moment its
   *  parent-commit is processed. Never itself reached on an equal (generation,
   *  date) pair twice, since each id is queued at most once per distinct call. */
  readonly ins: number;
}

/** Higher generation pops first, then newer date, then Git's own FIFO
 *  insertion-order tie-break — see {@link paint}'s doc comment. */
const precedesInPaint = (a: PaintEntry, b: PaintEntry): boolean => {
  if (a.generation !== b.generation) return a.generation > b.generation;
  if (a.date !== b.date) return a.date > b.date;
  return a.ins < b.ins;
};

/**
 * Paint commits down to their common ancestors (Git's `paint_down_to_common`).
 * `one` carries PARENT1, every `twos` carries PARENT2; a commit reached by both
 * is flagged RESULT, and STALE propagates from it to prune deeper ancestors.
 * `minGeneration` stops the walk as soon as a popped commit falls below it
 * (Git's own cutoff, sound because a graph-covered commit can never descend
 * from a graph-absent one — see the design's soundness note). Pop order is
 * higher generation first, then newer date, then Git's own FIFO insertion-order
 * tie-break (`compare_commits_by_gen_then_commit_date` plus `prio_queue`'s
 * counter) — not `precedes`'s oid tie-break, which the shared blame walk needs
 * but a same-second merge-base tie does not reproduce.
 * Returns the per-call flag map; isolated state, so no mark-clearing is needed.
 */
const paint = async (
  read: ReadCommit,
  one: ObjectId,
  twos: readonly ObjectId[],
  minGeneration: number,
): Promise<Map<ObjectId, number>> => {
  const flags = new Map<ObjectId, number>();
  let insertions = 0;
  const heap = new BinaryHeap<PaintEntry>(precedesInPaint);
  const mark = async (id: ObjectId, bits: number): Promise<void> => {
    flags.set(id, (flags.get(id) ?? 0) | bits);
    const meta = await read(id);
    heap.push({
      oid: id,
      date: dateOf(meta),
      generation: generationOf(meta),
      ins: insertions++,
      value: undefined,
    });
  };
  await mark(one, PARENT1);
  for (const two of twos) await mark(two, PARENT2);
  while (hasNonStale(heap.entries(), flags)) {
    const { oid: id, generation } = heap.pop()!;
    if (generation < minGeneration) break;
    let f = (flags.get(id) ?? 0) & (BOTH | STALE);
    if (f === BOTH) {
      flags.set(id, (flags.get(id) ?? 0) | RESULT);
      // Stryker disable next-line all: equivalent — STALE only stops a found
      // base's ancestors from being collected as (redundant) bases; `removeRedundant`
      // drops those independently, so the final reduced set is unchanged either way.
      f |= STALE;
    }
    const meta = await read(id);
    for (const parent of meta?.parents ?? []) {
      // Stryker disable next-line all: equivalent — this skip only avoids re-marking
      // a parent that already carries every bit in `f`; without it the re-mark is
      // idempotent and still terminates on a finite DAG with the identical flag map.
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

/** The lowest generation across a candidate array (Git's `remove_redundant_no_gen`
 *  minimum-over-the-array); the floor `paint` breaks the reduction walk at. */
const minGenerationOf = async (read: ReadCommit, commits: readonly ObjectId[]): Promise<number> => {
  let min = GENERATION_INFINITY;
  for (const id of commits) min = Math.min(min, generationOf(await read(id)));
  return min;
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
  // Stryker disable next-line all: equivalent — a fast-path only; the loop below
  // already returns a 0/1-element input unchanged (a lone candidate has no `others`
  // to be reachable from, so it is always kept), so weakening this guard is a no-op.
  if (unique.length <= 1) return unique;
  const minGeneration = await minGenerationOf(read, unique);
  const kept: ObjectId[] = [];
  for (const candidate of unique) {
    const others = unique.filter((o) => o !== candidate);
    const flags = await paint(read, candidate, others, minGeneration);
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
  const results = collectResults(await paint(read, one, twos, 0));
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
 * The single-result pick: the reduced base with the newest committer date. A
 * stable sort over the reduced set's own discovery order settles ties —
 * measured against real Git on a same-committer-second criss-cross, both
 * with and without a commit-graph (see the interop suite).
 */
const newestBase = async (
  read: ReadCommit,
  bases: readonly ObjectId[],
): Promise<readonly ObjectId[]> => {
  if (bases.length === 0) return [];
  const dated = await Promise.all(bases.map(async (id) => ({ id, date: dateOf(await read(id)) })));
  const [newest] = [...dated].sort((a, b) => b.date - a.date);
  return [newest!.id];
};

/**
 * Compute merge bases — the best common ancestors of the given commits.
 *
 * `commits[0]` is `one`, the rest are the others. Returns the single base
 * with the newest committer date by default, ties resolved as Git's own
 * generation-then-date-ordered walk resolves them; the full reduced set,
 * oid-sorted, with `{ all: true }`; the octopus fold with `{ octopus: true }`.
 * Unrelated histories yield `[]`.
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
  if (options?.all === true) return [...bases].sort();
  return newestBase(read, bases);
};

import { BinaryHeap } from '../../domain/commit/binary-heap.js';
import type { QueueEntry } from '../../domain/commit/priority-queue.js';
import { invalidWalkInput, operationAborted } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { correctedCommitDatesEnabled } from './internal/read-commit-graph.js';
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
    // The graph-first paint reads no object bytes, so this reader is merge-base's
    // only per-commit checkpoint for cancellation — the cadence `readObject`
    // gave on the object path (git checks between pops the same way).
    if (ctx.signal?.aborted) throw operationAborted();
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
): boolean => queue.some((entry) => ((flags.get(entry.oid) ?? 0) & STALE) === 0);

interface PaintEntry extends QueueEntry<undefined> {
  readonly generation: number;
  /** Git's `prio_queue` insertion counter: among entries with equal keys, the
   *  one queued first pops first. A total tie-break, because an id sits in the
   *  queue at most once at a time (Git's ENQUEUED bit, mirrored by
   *  {@link paint}'s `queued` set), so no two entries ever share an id. */
  readonly ins: number;
  /** The commit's parents, read once when the entry was queued, so the pop
   *  loop expands them without a second (memoised, still asynchronous) read. */
  readonly parents: ReadonlyArray<ObjectId>;
}

type Precedes = (a: PaintEntry, b: PaintEntry) => boolean;

/** Git's `prio_queue` FIFO tie-break on an otherwise-equal key. */
const byInsertion: Precedes = (a, b) => a.ins < b.ins;

/** Git's `compare_commits_by_commit_date` — newest committer date first. */
const byDate: Precedes = (a, b) => (a.date !== b.date ? a.date > b.date : byInsertion(a, b));

/** Git's `compare_commits_by_gen_then_commit_date` — highest generation first. */
const byGenerationThenDate: Precedes = (a, b) =>
  a.generation !== b.generation ? a.generation > b.generation : byDate(a, b);

interface PaintOptions {
  /** Popping below this generation stops the walk — Git's reduction floor. */
  readonly minGeneration: number;
  /** Git's `MERGE_BASE_FIND_ALL`: collect every base instead of stopping at the first. */
  readonly findAll: boolean;
  /** Git's chain-wide `corrected_commit_dates_enabled` verdict. */
  readonly correctedCommitDates: boolean;
}

interface PaintOutcome {
  readonly flags: ReadonlyMap<ObjectId, number>;
  /** Bases in the order the walk POPPED them. Git appends to its RESULT list at
   *  the moment a commit is first flagged, so this is the list `merge_bases_many`
   *  goes on to filter and date-sort — not the order commits were discovered in. */
  readonly results: readonly ObjectId[];
}

/**
 * Paint commits down to their common ancestors (Git's `paint_down_to_common`).
 * `one` carries PARENT1, every `twos` carries PARENT2; a commit reached by both
 * is flagged RESULT, and STALE propagates from it to prune deeper ancestors.
 * `minGeneration` stops the walk as soon as a popped commit falls below it
 * (Git's own cutoff, sound because a graph-covered commit can never descend
 * from a graph-absent one — see the design's soundness note).
 *
 * Pop order is Git's: generation first, then newer date, then its `prio_queue`
 * FIFO counter — EXCEPT on a discovery walk (`minGeneration` 0) of a repository
 * whose commit-graph serves no corrected commit dates, where Git swaps in the
 * date-only comparator because topological levels and corrected commit dates
 * are not comparable quantities.
 *
 * Without `findAll` the walk stops at the FIRST base it pops, provided that
 * base has a finite generation: that base is the single line `git merge-base`
 * prints, and it is not in general the newest-dated one.
 *
 * Returns the per-call flag map and result list; isolated state, so no
 * mark-clearing is needed.
 */
const paint = async (
  read: ReadCommit,
  one: ObjectId,
  twos: readonly ObjectId[],
  options: PaintOptions,
): Promise<PaintOutcome> => {
  const queue = makePaintQueue(read, comparatorFor(options));
  const results: ObjectId[] = [];
  await queue.mark(one, PARENT1);
  // Git's `if (!n)` exit: with nothing to paint against, `one` is trivially its
  // own base and not one ancestor is walked.
  if (twos.length === 0) return { flags: queue.flags, results: [one] };
  for (const two of twos) await queue.mark(two, PARENT2);
  for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
    if (entry.generation < options.minGeneration) break;
    const inherited = visit(queue.flags, entry, results, options);
    if ((inherited & DONE) !== 0) break;
    for (const parent of entry.parents) {
      // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — this
      // skip only avoids re-marking a parent that already carries every inherited bit;
      // without it the re-mark is idempotent (no new bit, the RESULT guard refuses a
      // re-record, a re-popped entry outranks nothing newer) and still terminates on a
      // finite DAG with the identical flag map and result list. The `??` fallback's `&&`
      // form reads a marked parent as 0 and merely disables the same skip.
      if (((queue.flags.get(parent) ?? 0) & inherited) === inherited) continue;
      await queue.mark(parent, inherited);
    }
  }
  return { flags: queue.flags, results };
};

/** Git swaps its generation-aware comparator for the date-only one on a
 *  discovery walk whose graph serves no corrected commit dates: a topological
 *  level and a committer second are not comparable quantities. */
const comparatorFor = (options: PaintOptions): Precedes =>
  options.minGeneration === 0 && !options.correctedCommitDates ? byDate : byGenerationThenDate;

interface PaintQueue {
  readonly flags: Map<ObjectId, number>;
  readonly mark: (id: ObjectId, bits: number) => Promise<void>;
  /** The next non-stale commit, or `undefined` once every waiting entry is
   *  stale (Git's `while (queue.max_nonstale)`). */
  readonly pop: () => PaintEntry | undefined;
}

/** Git's `nonstale_queue`: the per-walk flag map plus an ordered queue that
 *  holds each id at most once. */
const makePaintQueue = (read: ReadCommit, precedes: Precedes): PaintQueue => {
  const flags = new Map<ObjectId, number>();
  const queued = new Set<ObjectId>();
  const heap = new BinaryHeap<PaintEntry>(precedes);
  let insertions = 0;
  return {
    flags,
    mark: async (id, bits) => {
      flags.set(id, (flags.get(id) ?? 0) | bits);
      // Git's ENQUEUED bit: an id waits in the queue at most once, so re-reaching
      // it only merges flags into the entry already queued.
      // Stryker disable next-line ConditionalExpression: equivalent — a duplicate entry
      // carries the same id, hence the same generation and date, so it can only pop
      // AFTER its twin; by then the twin has already recorded the base (`visit`'s
      // RESULT guard skips the re-record) and propagated STALE, and re-propagating
      // the same bits to the same parents is idempotent. A twin that popped carrying
      // STALE leaves the duplicate popping with STALE too, so `visit` never records
      // it and its parents already carry STALE — the bits it adds land only on STALE
      // commits, which neither the result filter nor `removeRedundant` reads.
      // Queueing twice costs pops, never a different flag map or result list.
      if (queued.has(id)) return;
      queued.add(id);
      const meta = await read(id);
      heap.push({
        oid: id,
        date: dateOf(meta),
        generation: generationOf(meta),
        ins: insertions++,
        parents: meta?.parents ?? [],
        value: undefined,
      });
    },
    pop: () => {
      if (!hasNonStale(heap.entries(), flags)) return undefined;
      const entry = heap.pop()!;
      queued.delete(entry.oid);
      return entry;
    },
  };
};

/** `visit`'s own stop signal, packed beside the flag bits it returns and never
 *  written to a flag map: Git breaks out of the walk the moment a single-result
 *  run records its base. */
const DONE = 16;

/** One pop of Git's loop: record the commit as a base when it carries both
 *  marks, and return the bits its parents inherit (plus DONE to stop). */
const visit = (
  flags: Map<ObjectId, number>,
  entry: PaintEntry,
  results: ObjectId[],
  options: PaintOptions,
): number => {
  const carried = (flags.get(entry.oid) ?? 0) & (BOTH | STALE);
  if (carried !== BOTH) return carried;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — the
  // counterpart to the ENQUEUED dedup: an id already recorded carries BOTH, so the
  // only bit a later mark can add is STALE, and a re-pop then reads `carried` as
  // BOTH|STALE and never reaches here. Git keeps the guard for the same defensive
  // reason, and `removeRedundant`'s dedupe would absorb a repeat regardless.
  if (((flags.get(entry.oid) ?? 0) & RESULT) === 0) {
    flags.set(entry.oid, (flags.get(entry.oid) ?? 0) | RESULT);
    results.push(entry.oid);
    if (!options.findAll && entry.generation < GENERATION_INFINITY) return carried | DONE;
  }
  return carried | STALE;
};

/** Git's `commit_list_sort_by_date`: newest committer date first, stable, so
 *  commits sharing a second keep the order the walk produced them in. */
const byDateDescending = async (
  read: ReadCommit,
  ids: readonly ObjectId[],
): Promise<ObjectId[]> => {
  const dated = await Promise.all(ids.map(async (id) => ({ id, date: dateOf(await read(id)) })));
  return dated.sort((a, b) => b.date - a.date).map((entry) => entry.id);
};

/** The lowest generation across a candidate set (Git's `remove_redundant_no_gen`
 *  minimum over the candidate plus every rival not yet ruled redundant); the
 *  floor `paint` breaks the reduction walk at. */
const lowestGeneration = async (
  read: ReadCommit,
  commits: readonly ObjectId[],
): Promise<number> => {
  let lowest = GENERATION_INFINITY;
  for (const id of commits) lowest = Math.min(lowest, generationOf(await read(id)));
  return lowest;
};

/**
 * Drop commits reachable from another in the set (Git's `remove_redundant_no_gen`).
 * A candidate is redundant iff it is an ancestor of another: painting it as
 * PARENT1 against the rest as PARENT2, it picks up PARENT2 exactly when some
 * other commit reaches down to it — and every rival it reaches picks up
 * PARENT1, so one walk settles both directions. Rivals already ruled redundant
 * drop out of later walks, which is what lifts the floor as the pass proceeds.
 */
const removeRedundant = async (
  read: ReadCommit,
  commits: readonly ObjectId[],
  correctedCommitDates: boolean,
): Promise<ObjectId[]> => {
  const unique = [...new Set(commits)];
  const redundant = new Set<ObjectId>();
  for (const candidate of unique) {
    if (redundant.has(candidate)) continue;
    const others = unique.filter((other) => other !== candidate && !redundant.has(other));
    const minGeneration = await lowestGeneration(read, [candidate, ...others]);
    const { flags } = await paint(read, candidate, others, {
      minGeneration,
      findAll: true,
      correctedCommitDates,
    });
    if (((flags.get(candidate) ?? 0) & PARENT2) !== 0) redundant.add(candidate);
    for (const other of others) {
      if (((flags.get(other) ?? 0) & PARENT1) !== 0) redundant.add(other);
    }
  }
  return unique.filter((id) => !redundant.has(id));
};

/**
 * Git's `merge_bases_many` followed by `get_merge_bases_many_0`'s reduction:
 * paint, drop bases that a later base staled out, date-sort, and — only when
 * more than one survives — reduce and date-sort again.
 */
const mergeBasesMany = async (
  read: ReadCommit,
  one: ObjectId,
  twos: readonly ObjectId[],
  options: { readonly findAll: boolean; readonly correctedCommitDates: boolean },
): Promise<ObjectId[]> => {
  // Git's own shortcut: a commit compared against itself is its own base, and
  // is deliberately left unflagged so nothing has to be cleaned up afterwards.
  if (twos.includes(one)) return [one];
  const { flags, results } = await paint(read, one, twos, { ...options, minGeneration: 0 });
  // Stryker disable next-line MethodExpression,ConditionalExpression,LogicalOperator: equivalent — STALE reaches a recorded base
  // only along a path down from another recorded base, so every commit this
  // drops is an ancestor of a survivor and `removeRedundant` below would drop
  // it anyway; dropping it here only spares that base its own reduction walk.
  const alive = results.filter((id) => ((flags.get(id) ?? 0) & STALE) === 0);
  const sorted = await byDateDescending(read, alive);
  if (sorted.length <= 1) return sorted;
  return byDateDescending(read, await removeRedundant(read, sorted, options.correctedCommitDates));
};

/**
 * Git's `get_octopus_merge_bases` plus `handle_octopus`'s `reduce_heads`: fold
 * each commit against every base gathered so far — always with FIND_ALL, the
 * way `repo_get_merge_bases` does — then dedupe and drop the reachable ones.
 * No final date sort: the surviving accumulator order is the order git prints.
 */
const octopusMergeBases = async (
  read: ReadCommit,
  commits: readonly ObjectId[],
  correctedCommitDates: boolean,
): Promise<ObjectId[]> => {
  let bases: ObjectId[] = [commits[0]!];
  for (const commit of commits.slice(1)) {
    const next: ObjectId[] = [];
    for (const base of bases) {
      const folded = await mergeBasesMany(read, commit, [base], {
        findAll: true,
        correctedCommitDates,
      });
      for (const id of folded) next.push(id);
    }
    bases = next;
  }
  return removeRedundant(read, bases, correctedCommitDates);
};

/**
 * Compute merge bases — the best common ancestors of the given commits.
 *
 * `commits[0]` is `one`, the rest are the others. By default the answer is the
 * single base Git's walk pops FIRST: the newest-dated common base in a
 * repository with no commit-graph, but the highest-generation one wherever a
 * graph serves corrected commit dates — the two disagree whenever a base
 * inherits its generation from an ancestor committed later than itself.
 * `{ all: true }` returns the whole reduced set, oid-sorted. `{ octopus: true }`
 * folds the commits pairwise and reports the reduced accumulator in Git's fold
 * order — each pairwise fold date-sorted, the folds concatenated — so its first
 * entry is the newest base of the FIRST fold, not the newest overall. Unrelated
 * histories yield `[]`.
 */
export const mergeBase = async (
  ctx: Context,
  commits: readonly ObjectId[],
  options?: MergeBaseOptions,
): Promise<readonly ObjectId[]> => {
  if (commits.length === 0) throw invalidWalkInput('mergeBase requires at least one commit');
  const read = makeReadCommit(ctx);
  const findAll = options?.all === true;
  const correctedCommitDates = await correctedCommitDatesEnabled(ctx);
  const bases =
    options?.octopus === true
      ? await octopusMergeBases(read, commits, correctedCommitDates)
      : await mergeBasesMany(read, commits[0]!, commits.slice(1), {
          findAll,
          correctedCommitDates,
        });
  if (findAll) return [...bases].sort();
  return bases.slice(0, 1);
};

import { commitParseFailed } from '../../domain/commands/error.js';
import { BinaryHeap } from '../../domain/commit/binary-heap.js';
import type { QueueEntry } from '../../domain/commit/priority-queue.js';
import {
  invalidCommitName,
  invalidWalkInput,
  operationAborted,
  type TsgitError,
} from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import { isObjectNotFound } from '../../domain/objects/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { lookupTypedCommitReference } from './internal/lookup-commit-reference.js';
import {
  assignObjectType,
  createObjectTypeTable,
  type ObjectTypeTable,
  typeGraphParents,
} from './internal/object-type-table.js';
import {
  correctedCommitDatesEnabled,
  generationNumbersEnabled,
} from './internal/read-commit-graph.js';
import {
  type CommitMeta,
  GENERATION_INFINITY,
  GENERATION_NUMBER_V1_MAX,
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

/** A read of a commit the walk needs parsed — it refuses rather than answer none. */
type ReadCommit = (id: ObjectId) => Promise<CommitMeta>;

/** A read that answers `undefined` for an id naming no commit. */
type ReadMaybeCommit = (id: ObjectId) => Promise<CommitMeta | undefined>;

type ReadMeta<M extends CommitMeta | undefined> = (ctx: Context, id: ObjectId) => Promise<M>;

const memoizedReader = <M extends CommitMeta | undefined>(
  ctx: Context,
  readMeta: ReadMeta<M>,
  known: ReadonlyMap<ObjectId, CommitMeta> = new Map(),
): ((id: ObjectId) => Promise<CommitMeta | M>) => {
  const cache = new Map<ObjectId, CommitMeta | M>(known);
  return async (id) => {
    // The graph-first paint reads no object bytes, so this reader is merge-base's
    // only per-commit checkpoint for cancellation — the cadence `readObject`
    // gave on the object path (git checks between pops the same way).
    if (ctx.signal?.aborted) throw operationAborted();
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const meta = await readMeta(ctx, id);
    cache.set(id, meta);
    return meta;
  };
};

const ABSENT = 'absent';

/** The commit's metadata, `undefined` for another type, or {@link ABSENT} when the store lacks it. */
const readMetaOrAbsent = async (
  ctx: Context,
  id: ObjectId,
): Promise<CommitMeta | undefined | typeof ABSENT> => {
  try {
    return await readCommitMeta(ctx, id);
  } catch (error) {
    if (isObjectNotFound(error)) return ABSENT;
    throw error;
  }
};

/** git's `repo_parse_commit`, not quiet: an absent object or one of another
 *  type logs why and reads as no commit. */
const readLoggedMeta: ReadMeta<CommitMeta | undefined> = async (ctx, id) => {
  const meta = await readMetaOrAbsent(ctx, id);
  if (meta !== ABSENT && meta !== undefined) return meta;
  const line = meta === ABSENT ? `Could not read ${id}` : `Object ${id} not a commit`;
  ctx.logger?.error?.(line, { id });
  return undefined;
};

/** git's `paint_down_to_common` parse: a parent that fails to parse refuses
 *  the walk with `could not parse commit`, after the line it logs. */
const readParsedMeta: ReadMeta<CommitMeta> = async (ctx, id) => {
  const meta = await readLoggedMeta(ctx, id);
  if (meta === undefined) throw commitParseFailed(id);
  return meta;
};

/**
 * git's parse of a walk parent against the call's object table: from the
 * graph, `fill_commit_in_graph` types each parent a commit and dies
 * `could not find commit` on a conflict; from the object, `parse_commit_buffer`
 * types the tree then each parent, and a conflict fails the parse.
 */
const typedParsedMeta =
  (table: ObjectTypeTable): ReadMeta<CommitMeta> =>
  async (ctx, id) => {
    const meta = await readParsedMeta(ctx, id);
    if (!typeParsedPointers(ctx, table, id, meta)) throw commitParseFailed(id);
    return meta;
  };

/** git's `repo_parse_commit` of a depth-first parent against the table: a
 *  parse that fails — a typing conflict included — logs why and is skipped. */
const typedLoggedMeta =
  (table: ObjectTypeTable): ReadMeta<CommitMeta | undefined> =>
  async (ctx, id) => {
    const meta = await readLoggedMeta(ctx, id);
    return meta !== undefined && typeParsedPointers(ctx, table, id, meta) ? meta : undefined;
  };

/** Types `meta`'s pointers the way its source parses them; `false` once the
 *  object parse's typing conflicted — the graph's conflict dies instead. */
const typeParsedPointers = (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
  meta: CommitMeta,
): boolean => {
  if (meta.source !== 'graph') return typeCommitPointers(ctx, table, id, meta);
  typeGraphParents(ctx, table, meta.parents);
  return true;
};

const typeCommitPointers = (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
  meta: CommitMeta,
): boolean => {
  const conflict = pointerConflict(ctx, table, meta);
  if (conflict === undefined) return true;
  ctx.logger?.error?.(`${conflict.pointer} ${conflict.target} in commit ${id}`, { id });
  return false;
};

/** The first of the commit's pointers whose typing conflicts, with git's name for it. */
const pointerConflict = (
  ctx: Context,
  table: ObjectTypeTable,
  meta: CommitMeta,
): { readonly pointer: string; readonly target: ObjectId } | undefined => {
  if (!assignObjectType(ctx, table, meta.tree, 'tree')) {
    return { pointer: 'bad tree pointer', target: meta.tree };
  }
  const parent = meta.parents.find((id) => !assignObjectType(ctx, table, id, 'commit'));
  return parent === undefined ? undefined : { pointer: 'bad parent', target: parent };
};

const makeReadCommit = (ctx: Context, table: ObjectTypeTable): ReadCommit =>
  memoizedReader(ctx, typedParsedMeta(table));

/** The commit's metadata, `undefined` — quietly — for an absent object or
 *  one of another type: how git's reachability callers parse their ends. */
const readMetaOrMissing: ReadMeta<CommitMeta | undefined> = async (ctx, id) => {
  const meta = await readMetaOrAbsent(ctx, id);
  return meta === ABSENT ? undefined : meta;
};

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
// Stryker disable next-line EqualityOperator: equivalent — `ins` is a unique
// per-entry counter (insertions++ on every push), so a.ins === b.ins never
// holds and `<` and `<=` order every pair identically.
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
  /** Generations at or above this are not strictly topological: Git's
   *  `topo_ceiling`, past which the early exits no longer hold. */
  readonly topoCeiling: number;
}

/** Git's chain-wide `corrected_commit_dates_enabled` verdict as a ceiling. */
const topoCeilingFor = (correctedCommitDates: boolean): number =>
  correctedCommitDates ? GENERATION_INFINITY : GENERATION_NUMBER_V1_MAX;

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
 * FIFO counter. The walk also stops, as Git's does, once one side has no
 * queued entry left and no candidate is waiting, while the head is below
 * `topoCeiling`.
 *
 * Without `findAll` the walk stops at the FIRST base it pops, provided that
 * base lies below `topoCeiling`: that base is the single line `git merge-base`
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
  const queue = makePaintQueue(read, byGenerationThenDate, options.topoCeiling);
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

interface PaintQueue {
  readonly flags: Map<ObjectId, number>;
  readonly mark: (id: ObjectId, bits: number) => Promise<void>;
  /** The next commit worth painting, or `undefined` once Git's
   *  `paint_queue_get` would stop: only stale entries remain, or one side ran
   *  dry inside the ordered region with no candidate left to pop. */
  readonly pop: () => PaintEntry | undefined;
}

/** Git's `paint_state` counters: each queued non-stale entry sits in exactly
 *  one bucket — PARENT1-only, PARENT2-only, or both (a pending base). */
interface PaintCounts {
  parent1: number;
  parent2: number;
  candidates: number;
}

/** Git's `paint_count_update`. */
const countBucket = (counts: PaintCounts, bits: number, delta: number): void => {
  switch (bits & (BOTH | STALE)) {
    case PARENT1:
      counts.parent1 += delta;
      return;
    case PARENT2:
      counts.parent2 += delta;
      return;
    case BOTH:
      counts.candidates += delta;
      return;
  }
};

/** Git's exit conditions in `paint_queue_get`, judged while the head is still
 *  counted, so the last non-stale entry is still handed out. */
const walkIsOver = (counts: PaintCounts, generation: number, topoCeiling: number): boolean => {
  if (counts.candidates !== 0) return false;
  if (counts.parent1 === 0 && counts.parent2 === 0) return true;
  const oneSideDry = counts.parent1 === 0 || counts.parent2 === 0;
  return oneSideDry && generation < topoCeiling;
};

interface PaintState {
  readonly flags: Map<ObjectId, number>;
  readonly queued: Set<ObjectId>;
  readonly counts: PaintCounts;
  readonly heap: BinaryHeap<PaintEntry>;
  insertions: number;
}

const markPainted = async (
  state: PaintState,
  read: ReadCommit,
  id: ObjectId,
  bits: number,
): Promise<void> => {
  const { flags, queued, counts, heap } = state;
  const before = flags.get(id) ?? 0;
  const after = before | bits;
  flags.set(id, after);
  // Git's ENQUEUED bit: an id waits in the queue at most once, so re-reaching
  // it only merges flags into the entry already queued — and moves it to the
  // bucket those flags now put it in (`paint_queue_put`).
  if (queued.has(id)) {
    countBucket(counts, before, -1);
    countBucket(counts, after, 1);
    return;
  }
  queued.add(id);
  const meta = await read(id);
  heap.push({
    oid: id,
    date: meta.committerDate,
    generation: meta.generation,
    ins: state.insertions++,
    parents: meta.parents,
    value: undefined,
  });
  countBucket(counts, after, 1);
};

const popPainted = (state: PaintState, topoCeiling: number): PaintEntry | undefined => {
  const entry = state.heap.pop();
  if (entry === undefined) return undefined;
  state.queued.delete(entry.oid);
  if (walkIsOver(state.counts, entry.generation, topoCeiling)) return undefined;
  countBucket(state.counts, state.flags.get(entry.oid) ?? 0, -1);
  return entry;
};

/** Git's `paint_state` queue: the per-walk flag map plus an ordered queue that
 *  holds each id at most once. */
const makePaintQueue = (read: ReadCommit, precedes: Precedes, topoCeiling: number): PaintQueue => {
  const state: PaintState = {
    flags: new Map<ObjectId, number>(),
    queued: new Set<ObjectId>(),
    counts: { parent1: 0, parent2: 0, candidates: 0 },
    heap: new BinaryHeap<PaintEntry>(precedes),
    insertions: 0,
  };
  return {
    flags: state.flags,
    mark: (id, bits) => markPainted(state, read, id, bits),
    pop: () => popPainted(state, topoCeiling),
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
    if (!options.findAll && entry.generation < options.topoCeiling) return carried | DONE;
  }
  return carried | STALE;
};

/** Git's `commit_list_sort_by_date`: newest committer date first, stable, so
 *  commits sharing a second keep the order the walk produced them in. */
const byDateDescending = async (
  read: ReadCommit,
  ids: readonly ObjectId[],
): Promise<ObjectId[]> => {
  const dated = await Promise.all(
    ids.map(async (id) => ({ id, date: (await read(id)).committerDate })),
  );
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
  for (const id of commits) lowest = Math.min(lowest, (await read(id)).generation);
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
  topoCeiling: number,
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
      topoCeiling,
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
  options: { readonly findAll: boolean; readonly topoCeiling: number },
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
  return byDateDescending(read, await removeRedundant(read, sorted, options.topoCeiling));
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
  topoCeiling: number,
): Promise<ObjectId[]> => {
  let bases: ObjectId[] = [commits[0]!];
  for (const commit of commits.slice(1)) {
    const next: ObjectId[] = [];
    for (const base of bases) {
      const folded = await mergeBasesMany(read, commit, [base], {
        findAll: true,
        topoCeiling,
      });
      for (const id of folded) next.push(id);
    }
    bases = next;
  }
  return removeRedundant(read, bases, topoCeiling);
};

/**
 * Git's `repo_in_merge_bases`: whether `commit` is reachable from `reference`.
 *
 * Git never walks to answer this when the generations already settle it — a
 * commit younger than the reference cannot be its ancestor. An end that names
 * no commit — absent, or some other object type — answers `false` quietly, as
 * git's callers parse their ends before asking.
 *
 * With generation numbers (a commit-graph) git asks `can_all_from_reach`: a
 * depth-first descent from `reference` that stops at the first path down to
 * `commit` and prunes below `commit`'s generation — a parent that fails to
 * parse logs why and is skipped. Without them git paints down to `commit`, and
 * a parent that fails to parse refuses the walk (`COMMIT_PARSE_FAILED`) after
 * its line, the way `paint_down_to_common` does.
 *
 * Every parse types its pointers into `table` — the caller's, when its own
 * lookups already filled one, as git's process-wide table carries them;
 * otherwise a fresh one, typed first as the ends' own lookups would type it.
 */
export const inMergeBases = async (
  ctx: Context,
  commit: ObjectId,
  reference: ObjectId,
  table?: ObjectTypeTable,
): Promise<boolean> => {
  const target = await readMetaOrMissing(ctx, commit);
  const from = await readMetaOrMissing(ctx, reference);
  if (target === undefined || from === undefined) return false;
  const ends: Ends = { target: { id: commit, meta: target }, from: { id: reference, meta: from } };
  const walkTable = table ?? tableTypedByEnds(ctx, ends);
  if (walkTable === undefined || target.generation > from.generation) return false;
  if (await generationNumbersEnabled(ctx)) return reachesDepthFirst(ctx, ends, walkTable);
  return reachesByPaint(ctx, ends, walkTable);
};

/**
 * git's callers look both ends up and parse them before asking — the commit
 * end first — typing each a commit and then its pointers; `undefined` once
 * that typing conflicted, git's lookup failing with its lines logged.
 */
const tableTypedByEnds = (ctx: Context, { target, from }: Ends): ObjectTypeTable | undefined => {
  const table = createObjectTypeTable();
  const typed = [target, from].every(
    (end) =>
      assignObjectType(ctx, table, end.id, 'commit') &&
      typeParsedPointers(ctx, table, end.id, end.meta),
  );
  return typed ? table : undefined;
};

interface Parsed {
  readonly id: ObjectId;
  readonly meta: CommitMeta;
}

interface Ends {
  readonly target: Parsed;
  readonly from: Parsed;
}

const knownEnds = ({ target, from }: Ends): ReadonlyMap<ObjectId, CommitMeta> =>
  new Map([
    [target.id, target.meta],
    [from.id, from.meta],
  ]);

/** Git's `repo_in_merge_bases_many`: `target` painted PARENT1, `from` PARENT2. */
const reachesByPaint = async (
  ctx: Context,
  ends: Ends,
  table: ObjectTypeTable,
): Promise<boolean> => {
  const read = memoizedReader(ctx, typedParsedMeta(table), knownEnds(ends));
  const { target, from } = ends;
  const { flags } = await paint(read, target.id, [from.id], {
    minGeneration: target.meta.generation,
    findAll: true,
    topoCeiling: topoCeilingFor(await correctedCommitDatesEnabled(ctx)),
  });
  return ((flags.get(target.id) ?? 0) & PARENT2) !== 0;
};

interface DepthFirst {
  readonly read: ReadMaybeCommit;
  readonly target: ObjectId;
  readonly minGeneration: number;
  /** Git's `assign_flag`: every commit already descended into or skipped. */
  readonly assigned: Set<ObjectId>;
  /** Git's `RESULT`: commits found to reach the target. */
  readonly reached: Set<ObjectId>;
}

const reaches = (walk: DepthFirst, id: ObjectId): boolean =>
  id === walk.target || walk.reached.has(id);

/** The next parent of `top` to descend into, marking `top` reached on the way
 *  when a parent already reaches the target; a parent that fails to parse —
 *  after its line — or sits below the floor is skipped. */
const nextParent = async (walk: DepthFirst, top: Parsed): Promise<Parsed | undefined> => {
  for (const parent of top.meta.parents) {
    if (reaches(walk, parent)) walk.reached.add(top.id);
    if (walk.assigned.has(parent)) continue;
    walk.assigned.add(parent);
    const meta = await walk.read(parent);
    if (meta !== undefined && meta.generation >= walk.minGeneration) return { id: parent, meta };
  }
  return undefined;
};

/** One turn of git's descent: a reaching top is popped, marking the commit
 *  below it reached; any other descends into its next parent, or is popped
 *  once it has none left. */
const step = async (walk: DepthFirst, stack: Parsed[], top: Parsed): Promise<void> => {
  if (reaches(walk, top.id)) {
    stack.pop();
    const below = stack.at(-1);
    if (below !== undefined) walk.reached.add(below.id);
    return;
  }
  const parent = await nextParent(walk, top);
  if (parent === undefined) stack.pop();
  else stack.push(parent);
};

/** Git's `can_all_from_reach_with_flag` for one `from` and one target. */
const reachesDepthFirst = async (
  ctx: Context,
  { target, from }: Ends,
  table: ObjectTypeTable,
): Promise<boolean> => {
  const walk: DepthFirst = {
    read: memoizedReader(ctx, typedLoggedMeta(table), new Map([[target.id, target.meta]])),
    target: target.id,
    minGeneration: target.meta.generation,
    assigned: new Set(),
    reached: new Set(),
  };
  const stack = [from];
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) await step(walk, stack, top);
  return reaches(walk, from.id);
};

/**
 * Compute merge bases — the best common ancestors of the given commits.
 *
 * `commits[0]` is `one`, the rest are the others. By default the answer is the
 * single base Git's walk pops FIRST: the newest-dated common base in a
 * repository with no commit-graph, but the highest-generation one wherever a
 * graph serves corrected commit dates — the two disagree whenever a base
 * inherits its generation from an ancestor committed later than itself.
 * `{ all: true }` returns the whole reduced set in the order `git merge-base
 * --all` prints it — newest date first, equal dates in the order the paint
 * found them. `{ octopus: true }`
 * folds the commits pairwise and reports the reduced accumulator in Git's fold
 * order — each pairwise fold date-sorted, the folds concatenated — so its first
 * entry is the newest base of the FIRST fold, not the newest overall. Unrelated
 * histories yield `[]`.
 *
 * Each id is first looked up as a commit, as `git merge-base` does — through
 * its annotated tags, against one object table for the whole call, last
 * first under `octopus` — refusing `INVALID_COMMIT_NAME` on the first that
 * names none, after git's `error:` lines for it are logged.
 */
export const mergeBase = async (
  ctx: Context,
  commits: readonly ObjectId[],
  options?: MergeBaseOptions,
): Promise<readonly ObjectId[]> => {
  if (commits.length === 0) throw invalidWalkInput('mergeBase requires at least one commit');
  const table = createObjectTypeTable();
  const looked = await lookUpArguments(
    ctx,
    table,
    commits,
    options?.octopus === true ? 'last-first' : 'given',
  );
  return mergeBasesOf(ctx, looked, options, table);
};

/** The order git's argument loop looks commits up in: `--octopus` goes last first. */
type LookupOrder = 'given' | 'last-first';

/** git's argument loop: each looked up in turn, in `order`, the result in the given order. */
const lookUpArguments = async (
  ctx: Context,
  table: ObjectTypeTable,
  ids: readonly ObjectId[],
  order: LookupOrder,
): Promise<ObjectId[]> => {
  const lastFirst = order === 'last-first';
  const peeled: ObjectId[] = [];
  for (const id of lastFirst ? [...ids].reverse() : ids) {
    const commit = await lookupTypedCommitReference(ctx, table, id);
    if (commit === undefined) throw invalidCommitName(id);
    peeled.push(commit);
  }
  return lastFirst ? peeled.reverse() : peeled;
};

/**
 * The merge-base computation over ids a command already holds as commits —
 * what git's own callers run on parsed commits, with no argument lookup.
 */
export const mergeBasesOf = async (
  ctx: Context,
  commits: readonly ObjectId[],
  options?: MergeBaseOptions,
  table: ObjectTypeTable = createObjectTypeTable(),
): Promise<readonly ObjectId[]> => {
  const read = makeReadCommit(ctx, table);
  const findAll = options?.all === true;
  const topoCeiling = topoCeilingFor(await correctedCommitDatesEnabled(ctx));
  const bases =
    options?.octopus === true
      ? await octopusMergeBases(read, commits, topoCeiling)
      : await mergeBasesMany(read, commits[0]!, commits.slice(1), {
          findAll,
          topoCeiling,
        });
  return findAll ? bases : bases.slice(0, 1);
};

/**
 * git's `reduce_heads`: `commits` deduped in order, less every one reachable
 * from another — the independent tips, in the order they were given.
 */
export const reduceHeads = async (
  ctx: Context,
  commits: readonly ObjectId[],
): Promise<readonly ObjectId[]> => {
  const read = makeReadCommit(ctx, createObjectTypeTable());
  return removeRedundant(read, commits, topoCeilingFor(await correctedCommitDatesEnabled(ctx)));
};

const COMMIT_PARSE_FAILED = 'COMMIT_PARSE_FAILED';

/**
 * git's `repo_get_merge_bases(...) < 0` for a caller that carries on: a walk
 * parent that fails to parse logs git's `could not parse commit` line and
 * answers `undefined` rather than refusing — `merge` reads it as no remote
 * heads left, `handle_dotdot` as no range.
 */
export const tryMergeBasesOf = (
  ctx: Context,
  commits: readonly ObjectId[],
  options?: MergeBaseOptions,
): Promise<readonly ObjectId[] | undefined> =>
  undefinedOnParseFailure(ctx, () => mergeBasesOf(ctx, commits, options));

/** git's `reduce_heads` as `merge` runs it: a parent that cannot be parsed is logged and leaves no head. */
export const tryReduceHeads = (
  ctx: Context,
  commits: readonly ObjectId[],
): Promise<readonly ObjectId[] | undefined> =>
  undefinedOnParseFailure(ctx, () => reduceHeads(ctx, commits));

const undefinedOnParseFailure = async <T>(
  ctx: Context,
  walk: () => Promise<T>,
): Promise<T | undefined> => {
  try {
    return await walk();
  } catch (error) {
    const id = parseFailureOf(error);
    if (id === undefined) throw error;
    ctx.logger?.error?.(`could not parse commit ${id}`, { id });
    return undefined;
  }
};

/** The parent a walk refused with `COMMIT_PARSE_FAILED` could not parse; `undefined` for any other refusal. */
export const parseFailureOf = (error: unknown): ObjectId | undefined =>
  errorDataCode(error) === COMMIT_PARSE_FAILED
    ? ((error as TsgitError).data as { readonly id: ObjectId }).id
    : undefined;

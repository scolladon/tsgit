import { commitLookupFailed, revisionWalkFailed } from '../../../domain/commands/error.js';
import { BinaryHeap } from '../../../domain/commit/binary-heap.js';
import { precedesByArrival } from '../../../domain/commit/priority-queue.js';
import { operationAborted } from '../../../domain/error.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type BoundedReader, createBoundedReader } from './bounded-reader.js';
import { limitFor } from './concurrency.js';
import { assignObjectType, type ObjectTypeTable, typeWalkedCommit } from './object-type-table.js';
import { readCommit } from './read-commit.js';
import { commitHeader, generationNumbersEnabled } from './read-commit-graph.js';
import { resolveShallow } from './shallow-set.js';

/** git's `SLOP`: uninteresting commits still examined once only uninteresting ones remain. */
const SLOP = 5;
/** A commit parsed from its object, not the commit-graph, is newer than any graph entry. */
const OUTSIDE_GRAPH = Number.POSITIVE_INFINITY;
/** Shown commit bodies read ahead of the consumer. */
const READ_AHEAD = 8;

/**
 * When the limited walk may stop. `'slop'` is git's `limit_list`: once every
 * queued commit is uninteresting and older than the last shown one, it looks
 * at {@link SLOP} more before giving up — a clock-skewed excluded line can
 * then leave an ancestor shown. `'generation'` is git's commit-graph topo
 * walk: it explores the excluded side until no queued commit can still be a
 * descendant of a shown one, so exclusion is exact.
 */
export type LimitSettle = 'slop' | 'generation';

export interface LimitListOptions {
  /**
   * Every named commit, included or excluded, in command-line order: git
   * queues commits sharing a date in that order, and which of them pops
   * first decides what the excluded side has marked by then.
   */
  readonly seeds: ReadonlyArray<ObjectId>;
  /** Excluded commits; they and every ancestor the walk reaches are uninteresting. */
  readonly until: ReadonlySet<ObjectId>;
  /** Follow only first parents of interesting commits; excluded lines follow all. */
  readonly firstParent: boolean;
  readonly ignoreMissing: boolean;
  readonly verifyHash: boolean;
  readonly shallow: ReadonlySet<ObjectId>;
  readonly settle: LimitSettle;
  /**
   * The invocation's object-type table: each parent parsed from its object is
   * typed as git's commit parse types it. An included commit's parent that
   * fails refuses with `REVISION_WALK_FAILED` naming that commit; an excluded
   * one's is logged and not walked on, as git's gentle parse leaves it.
   */
  readonly objectTypes?: ObjectTypeTable;
  /**
   * Stop once this many commits are taken, each after its parents are
   * parsed — git's streaming walk under `max_count`. Only for a walk with
   * nothing excluded, where no commit taken is dropped later. Omitted means
   * the walk runs to completion.
   */
  readonly takeAtMost?: number;
}

export interface LimitedWalk {
  /** Shown commits, newest commit date first and equal dates in arrival order. */
  readonly shown: ReadonlyArray<ObjectId>;
  /** Every commit found uninteresting — closed under the parents the walk parsed. */
  readonly uninteresting: ReadonlySet<ObjectId>;
  /** Commits taken into the list while interesting and found uninteresting later. */
  readonly dropped: ReadonlyArray<ObjectId>;
  /** Bodies of shown commits read while parsing them (those absent from the graph). */
  readonly bodies: ReadonlyMap<ObjectId, Commit>;
}

/** The walk-option slice a public walk hands over when it limits. */
export interface LimitWalkOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
  readonly shallow?: ReadonlySet<ObjectId>;
}

/** The walk's own knobs; `seeds` defaults to git's `<from> ^<until>` command-line order. */
type LimitSettings = Pick<LimitListOptions, 'until' | 'firstParent' | 'settle'> &
  Partial<Pick<LimitListOptions, 'seeds' | 'objectTypes' | 'takeAtMost'>>;

/** Complete a walk's options for {@link limitList}, loading `.git/shallow` when none is given. */
export const resolveLimitOptions = async (
  ctx: Context,
  options: LimitWalkOptions,
  limits: LimitSettings,
): Promise<LimitListOptions> => ({
  seeds: [...options.from, ...limits.until],
  ignoreMissing: options.ignoreMissing ?? false,
  verifyHash: options.verifyHash ?? false,
  shallow: await resolveShallow(ctx, options.shallow),
  ...limits,
});

/**
 * How git limits a topologically sorted walk: over a commit-graph carrying
 * generation numbers its topo walk settles by generation, else `limit_list`.
 */
export const topoOrderSettle = async (ctx: Context): Promise<LimitSettle> =>
  (await generationNumbersEnabled(ctx)) ? 'generation' : 'slop';

interface Parsed {
  readonly parents: ReadonlyArray<ObjectId>;
  readonly date: number;
  readonly generation: number;
}

interface Entry {
  readonly oid: ObjectId;
  readonly date: number;
  readonly arrival: number;
  readonly generation: number;
}

interface LimitState {
  readonly ctx: Context;
  readonly options: LimitListOptions;
  readonly parsed: Map<ObjectId, Parsed>;
  readonly bodies: Map<ObjectId, Commit>;
  /** Commits whose pointers the table already typed — git parses each once. */
  readonly typed: Set<ObjectId>;
  readonly missing: Set<string>;
  /** Commits a typing walk parsed from the commit-graph, whose parents it types on first use. */
  readonly fromGraph: Set<ObjectId>;
  /** Objects a typing walk read that are not commits — git's failed `repo_parse_commit`. */
  readonly notCommits: Set<ObjectId>;
  readonly uninteresting: Set<ObjectId>;
  readonly seen: Set<ObjectId>;
  readonly queue: BinaryHeap<Entry>;
  arrivals: number;
  /** git's `interesting_cache`: a queued commit last found interesting. */
  interestingCache: ObjectId | undefined;
  /** Lowest generation among commits taken into the shown list. */
  lowestShownGeneration: number;
}

/**
 * git's `limit_list`: walk the included and excluded commits together in
 * commit-date order, propagating UNINTERESTING down every parent of an
 * excluded commit (`mark_parents_uninteresting`), so an ancestor of an
 * excluded commit is left out even when an included commit reaches it by
 * another path. Commits taken into the list and later reached from the
 * excluded side are dropped, as git drops them when it shows the list.
 */
export async function limitList(ctx: Context, options: LimitListOptions): Promise<LimitedWalk> {
  const state = createState(ctx, options);
  await enqueueSeeds(state);
  const taken = await drain(state);
  const shown = taken.filter((id) => !state.uninteresting.has(id));
  const dropped = taken.filter((id) => state.uninteresting.has(id));
  return { shown, uninteresting: state.uninteresting, dropped, bodies: state.bodies };
}

/** {@link limitList}, then each shown commit's body, in the walk's order. */
export async function* walkLimited(
  ctx: Context,
  options: LimitListOptions,
): AsyncGenerator<Commit, void, undefined> {
  yield* readShown(ctx, options, await limitList(ctx, options));
}

/** Each of `walk`'s shown commit bodies, in the walk's order. */
export async function* readShown(
  ctx: Context,
  options: LimitListOptions,
  walk: LimitedWalk,
): AsyncGenerator<Commit, void, undefined> {
  const reader = shownReader(ctx, options, walk.bodies);
  for (const [index, id] of walk.shown.entries()) {
    if (ctx.signal?.aborted) throw operationAborted();
    for (const ahead of walk.shown.slice(index, index + READ_AHEAD)) reader.start(ahead);
    const commit = await reader.start(id);
    reader.forget(id);
    if (commit !== undefined) yield commit;
  }
}

const shownReader = (
  ctx: Context,
  options: LimitListOptions,
  bodies: ReadonlyMap<ObjectId, Commit>,
): BoundedReader<Commit | undefined> => {
  const missing = new Set<string>();
  const { verifyHash, ignoreMissing, shallow } = options;
  return createBoundedReader(limitFor(ctx, 'ioBound'), async (id) => {
    const parsed = bodies.get(id);
    if (parsed !== undefined) return parsed;
    return readCommit(ctx, id, { verifyHash, ignoreMissing, missing, shallow });
  });
};

const createState = (ctx: Context, options: LimitListOptions): LimitState => ({
  ctx,
  options,
  parsed: new Map(),
  bodies: new Map(),
  typed: new Set(),
  missing: new Set(),
  fromGraph: new Set(),
  notCommits: new Set(),
  uninteresting: new Set(),
  seen: new Set(),
  queue: new BinaryHeap<Entry>(precedesByArrival),
  arrivals: 0,
  interestingCache: undefined,
  lowestShownGeneration: OUTSIDE_GRAPH,
});

/**
 * git's `prepare_revision_walk`: each named commit is parsed, an excluded one
 * marks its parents uninteresting, and all of them are queued once.
 */
const enqueueSeeds = async (state: LimitState): Promise<void> => {
  const { seeds, until } = state.options;
  for (const seed of new Set(seeds)) {
    const parsed = await parse(state, seed, false);
    if (parsed === undefined) continue;
    if (until.has(seed)) {
      state.uninteresting.add(seed);
      markParentsUninteresting(state, seed);
    }
    state.seen.add(seed);
    enqueue(state, seed, parsed);
  }
};

const drain = async (state: LimitState): Promise<ReadonlyArray<ObjectId>> => {
  const taken: ObjectId[] = [];
  let slop = SLOP;
  let date = Number.POSITIVE_INFINITY;
  for (let entry = state.queue.pop(); entry !== undefined; entry = state.queue.pop()) {
    if (state.ctx.signal?.aborted) throw operationAborted();
    if (entry.oid === state.interestingCache) state.interestingCache = undefined;
    await processParents(state, entry.oid);
    if (state.uninteresting.has(entry.oid)) {
      markParentsUninteresting(state, entry.oid);
      state.bodies.delete(entry.oid);
      slop = keepWalking(state, date, slop);
      if (slop === 0) break;
      continue;
    }
    date = entry.date;
    state.lowestShownGeneration = Math.min(state.lowestShownGeneration, entry.generation);
    taken.push(entry.oid);
    if (taken.length === state.options.takeAtMost) break;
  }
  return taken;
};

const keepWalking = (state: LimitState, date: number, slop: number): number => {
  if (state.options.settle === 'slop') return stillInteresting(state, date, slop);
  return generationSettled(state) ? 0 : SLOP;
};

/** git's `still_interesting`. */
const stillInteresting = (state: LimitState, date: number, slop: number): number => {
  const head = state.queue.entries()[0];
  if (head === undefined) return 0;
  if (date <= head.date) return SLOP;
  if (!everybodyUninteresting(state)) return SLOP;
  return slop - 1;
};

/** No queued commit is interesting, nor young enough to descend from a shown one. */
const generationSettled = (state: LimitState): boolean =>
  everybodyUninteresting(state) &&
  state.queue.entries().every((entry) => entry.generation < state.lowestShownGeneration);

/** git's `everybody_uninteresting`. */
const everybodyUninteresting = (state: LimitState): boolean => {
  const cached = state.interestingCache;
  if (cached !== undefined && !state.uninteresting.has(cached)) return false;
  const interesting = state.queue.entries().find((entry) => !state.uninteresting.has(entry.oid));
  state.interestingCache = interesting?.oid;
  return interesting === undefined;
};

/** git's `process_parents`; each commit is popped once, so git's ADDED guard has no work here. */
const processParents = async (state: LimitState, id: ObjectId): Promise<void> => {
  const { parents } = state.parsed.get(id) as Parsed;
  if (state.uninteresting.has(id)) {
    await processUninterestingParents(state, parents);
    return;
  }
  const followed = state.options.firstParent ? parents.slice(0, 1) : parents;
  const parsed = await parseInOrder(state, followed);
  for (const [at, parent] of followed.entries()) {
    if (state.notCommits.has(parent) || !(await typeParsed(state, parent))) {
      throw revisionWalkFailed(id);
    }
    const entry = parsed[at];
    if (entry === undefined || state.seen.has(parent)) continue;
    state.seen.add(parent);
    enqueue(state, parent, entry);
  }
};

/**
 * git's commit parse typing `id`'s pointers, once, when its body was read
 * from the object — `false` once a typing conflicted and was logged.
 */
const typeParsed = async (state: LimitState, id: ObjectId): Promise<boolean> => {
  const table = state.options.objectTypes;
  if (table === undefined || state.typed.has(id)) return true;
  const body = state.bodies.get(id);
  if (body === undefined) {
    if (state.fromGraph.has(id)) typeGraphParents(state, table, id);
    return true;
  }
  // git marks a commit parsed only once its parse succeeds: a failed one is
  // parsed, and fails, again at every reach.
  const typed = await typeWalkedCommit(state.ctx, table, body);
  if (typed) state.typed.add(id);
  return typed;
};

/**
 * git's `fill_commit_in_graph`: each parent looked up as a commit, dying —
 * gentle parse or not — on one an earlier lookup typed otherwise.
 */
const typeGraphParents = (state: LimitState, table: ObjectTypeTable, id: ObjectId): void => {
  state.typed.add(id);
  for (const parent of (state.parsed.get(id) as Parsed).parents) {
    if (!assignObjectType(state.ctx, table, parent, 'commit')) throw commitLookupFailed(parent);
  }
};

/** Parents parsed concurrently; a refusal surfaces for the first in parent order, as git's loop meets it. */
const parseInOrder = async (
  state: LimitState,
  parents: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<Parsed | undefined>> => {
  const settled = await Promise.allSettled(parents.map((parent) => parse(state, parent, false)));
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
};

/** An uninteresting commit's parents are all marked, each parsed gently. */
const processUninterestingParents = async (
  state: LimitState,
  parents: ReadonlyArray<ObjectId>,
): Promise<void> => {
  for (const parent of parents) state.uninteresting.add(parent);
  const parsed = await Promise.all(parents.map((parent) => parse(state, parent, true)));
  for (const [at, parent] of parents.entries()) {
    const entry = parsed[at];
    if (entry === undefined || !(await typeParsed(state, parent))) continue;
    markParentsUninteresting(state, parent);
    if (state.seen.has(parent)) continue;
    state.seen.add(parent);
    enqueue(state, parent, entry);
  }
};

/** git's `mark_parents_uninteresting`: recurse only through parsed commits. */
const markParentsUninteresting = (state: LimitState, id: ObjectId): void => {
  const pending = [...(state.parsed.get(id) as Parsed).parents];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (state.uninteresting.has(next)) continue;
    state.uninteresting.add(next);
    pending.push(...(state.parsed.get(next)?.parents ?? []));
  }
};

const enqueue = (state: LimitState, oid: ObjectId, parsed: Parsed): void => {
  const arrival = state.arrivals;
  state.arrivals += 1;
  state.queue.push({ oid, date: parsed.date, arrival, generation: parsed.generation });
};

/**
 * git's `repo_parse_commit`: the commit-graph entry when there is one, else
 * the object. `gently` (an uninteresting parent) skips a missing object
 * instead of refusing.
 */
const parse = async (
  state: LimitState,
  id: ObjectId,
  gently: boolean,
): Promise<Parsed | undefined> => {
  const known = state.parsed.get(id);
  if (known !== undefined) return known;
  const { shallow, verifyHash, ignoreMissing } = state.options;
  const header = shallow.has(id) ? undefined : await commitHeader(state.ctx, id);
  if (header !== undefined) {
    const { parents, committerDate: date, generation } = header;
    if (state.options.objectTypes !== undefined) state.fromGraph.add(id);
    return remember(state, id, { parents, date, generation });
  }
  const commit = await readCommit(state.ctx, id, {
    verifyHash,
    ignoreMissing: gently || ignoreMissing,
    missing: state.missing,
    shallow,
  });
  if (commit === undefined) return notParsed(state, id);
  state.bodies.set(id, commit);
  const { parents, committer } = commit.data;
  return remember(state, id, { parents, date: committer.timestamp, generation: OUTSIDE_GRAPH });
};

/**
 * A commit read that found nothing to parse. Under typing, an object stored as
 * something else is git's `Object X not a commit` parse failure — logged on
 * every parse attempt, as git re-reads an object it could not parse.
 */
const notParsed = (state: LimitState, id: ObjectId): undefined => {
  if (state.options.objectTypes === undefined || state.missing.has(id)) return undefined;
  state.ctx.logger?.error?.(`Object ${id} not a commit`, { id });
  state.notCommits.add(id);
  return undefined;
};

const remember = (state: LimitState, id: ObjectId, parsed: Parsed): Parsed => {
  state.parsed.set(id, parsed);
  return parsed;
};

import { invalidWalkInput, operationAborted } from '../../domain/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { asIdSet } from './internal/as-id-set.js';
import { type BoundedReader, createBoundedReader } from './internal/bounded-reader.js';
import { limitFor } from './internal/concurrency.js';
import { limitList, resolveLimitOptions } from './internal/limit-list.js';
import { readCommit } from './internal/read-commit.js';
import { commitHeader } from './internal/read-commit-graph.js';
import { resolveShallow } from './internal/shallow-set.js';
import { MAX_WALK_QUEUE_SIZE, type WalkCommitsOptions } from './types.js';
import {
  exceedsMaxWalkSeeds,
  isEmptyFrom,
  REASON_WALK_EMPTY_FROM,
  REASON_WALK_QUEUE_OVERFLOW,
  REASON_WALK_TOO_MANY_SEEDS,
} from './validators.js';

interface WalkState {
  // queue only ever grows (drained via `head`, never `shift`), and `head` is
  // advanced in-place; both are declared without `readonly` to signal that
  // intent honestly. Sets are also mutated, but Set's API does not require
  // dropping the `readonly` qualifier on the reference.
  queue: ObjectId[];
  head: number;
  /** Ids pushed but not yet popped — git's ENQUEUED flag. An id is queued at
   *  most once at a time, so the array grows with the history's commits, never
   *  with its parent edges, and the bound below counts distinct pending ids. */
  readonly queued: Set<ObjectId>;
  readonly visited: Set<string>;
  readonly missing: Set<string>;
  readonly until: ReadonlySet<ObjectId>;
  readonly shallow: ReadonlySet<ObjectId>;
}

type Order = NonNullable<WalkCommitsOptions['order']>;
type CommitBodies = BoundedReader<Commit | undefined>;

interface WalkSession {
  readonly state: WalkState;
  readonly bodies: CommitBodies;
  readonly order: Order;
  readonly ignoreMissing: boolean;
}

async function createWalkSession(ctx: Context, options: WalkCommitsOptions): Promise<WalkSession> {
  const order = options.order ?? 'breadth-first';
  const ignoreMissing = options.ignoreMissing ?? false;
  const verifyHash = options.verifyHash ?? false;
  const shallow = await resolveShallow(ctx, options.shallow);
  const state: WalkState = {
    queue: [...options.from],
    head: 0,
    queued: new Set(options.from),
    visited: new Set<string>(),
    missing: new Set<string>(),
    until: asIdSet(options.until),
    shallow,
  };
  const bound = limitFor(ctx, 'ioBound');
  const bodies: CommitBodies = createBoundedReader(bound, (id) =>
    readCommit(ctx, id, { verifyHash, ignoreMissing, missing: state.missing, shallow }),
  );
  // Prime the initial seeds so their reads overlap instead of starting only
  // as each is individually popped. Must happen AFTER shallow resolves —
  // priming already triggers grafted reads.
  for (const seed of state.queue) bodies.start(seed);
  return { state, bodies, order, ignoreMissing };
}

interface FrontierEntry {
  readonly commit: Commit | undefined;
  /** True when parents were already enqueued from the commit-graph header. */
  readonly enqueuedFromHeader: boolean;
}

/**
 * Resolve one popped id: prefer the commit-graph header — its parents are
 * enqueued (and their own reads prefetched) BEFORE this id's own body read
 * completes, the parallelism lever — falling back to the body itself only
 * when the graph doesn't cover it (or `id` is a shallow boundary).
 */
async function resolveFrontierEntry(
  ctx: Context,
  session: WalkSession,
  id: ObjectId,
): Promise<FrontierEntry> {
  const { state, bodies, order, ignoreMissing } = session;
  const header = state.shallow.has(id) ? undefined : await commitHeader(ctx, id);
  // Early enqueue is the parallelism lever, but under `ignoreMissing` a
  // stale graph could name parents of a commit whose body is gone — and a
  // missing commit's parents must NOT be walked. Defer to body-confirmed
  // there; without `ignoreMissing` a missing body aborts the walk anyway,
  // so the early enqueue is unobservable.
  if (header !== undefined && !ignoreMissing) {
    enqueueIds(state, selectParentIds(header.parents, order), bodies);
  }
  const commit = await bodies.start(id);
  // Consumed: drop the memo entry (the walk's visited/seen sets already stop
  // any re-enqueue), or a full-history drain retains every body simultaneously.
  bodies.forget(id);
  if (header !== undefined && ignoreMissing && commit !== undefined) {
    enqueueIds(state, selectParentIds(header.parents, order), bodies);
  }
  return { commit, enqueuedFromHeader: header !== undefined };
}

/**
 * Walk the commits reachable from `from` in queue order: breadth-first, or
 * along first parents only. Excluded commits (`until`) are settled first as git's `limit_list`
 * does, so an ancestor of an excluded commit is never yielded, whichever path
 * reaches it.
 */
export function walkCommits(ctx: Context, options: WalkCommitsOptions): AsyncIterable<Commit> {
  const until = asIdSet(options.until);
  return until.size > 0 ? walkExcluding(ctx, options, until) : walkCommitsStoppingAt(ctx, options);
}

async function* walkExcluding(
  ctx: Context,
  options: WalkCommitsOptions,
  until: ReadonlySet<ObjectId>,
): AsyncIterable<Commit> {
  validateOptions(options);
  const limits = { until, firstParent: options.order === 'first-parent', settle: 'slop' } as const;
  const { uninteresting } = await limitList(ctx, await resolveLimitOptions(ctx, options, limits));
  yield* walkCommitsStoppingAt(ctx, { ...options, until: uninteresting });
}

/**
 * {@link walkCommits} stopping only at the `until` commits themselves — for
 * callers whose `until` already holds every ancestor of what they exclude.
 */
export async function* walkCommitsStoppingAt(
  ctx: Context,
  options: WalkCommitsOptions,
): AsyncIterable<Commit> {
  validateOptions(options);
  const session = await createWalkSession(ctx, options);
  const { state, bodies, order } = session;

  while (state.head < state.queue.length) {
    if (ctx.signal?.aborted) throw operationAborted();
    const id = state.queue[state.head]!;
    state.head += 1;
    state.queued.delete(id);
    if (state.visited.has(id) || state.missing.has(id) || state.until.has(id)) continue;

    const { commit, enqueuedFromHeader } = await resolveFrontierEntry(ctx, session, id);
    if (commit === undefined) continue;
    state.visited.add(id);
    // Graph-absent commit: parents were not yet known, so enqueue them from
    // the just-read body.
    if (!enqueuedFromHeader) {
      enqueueParents(state, commit, order, bodies);
    }
    await parseFollowedParents(ctx, session, commit);
    yield commit;
  }
}

/**
 * git's `process_parents` runs before a commit is shown: each followed parent
 * is parsed — from its commit-graph entry when it has one, else from its
 * object — so an unreadable parent refuses ahead of its child. The reads are
 * the ones the enqueue already started; this only awaits them earlier.
 */
async function parseFollowedParents(
  ctx: Context,
  session: WalkSession,
  commit: Commit,
): Promise<void> {
  const { state, bodies, order } = session;
  if (state.shallow.has(commit.id)) return;
  for (const parent of selectParentIds(commit.data.parents, order)) {
    if (state.visited.has(parent) || state.missing.has(parent) || state.until.has(parent)) continue;
    const header = state.shallow.has(parent) ? undefined : await commitHeader(ctx, parent);
    if (header === undefined) await bodies.start(parent);
  }
}

function validateOptions(options: WalkCommitsOptions): void {
  if (isEmptyFrom(options.from)) {
    throw invalidWalkInput(REASON_WALK_EMPTY_FROM);
  }
  if (exceedsMaxWalkSeeds(options.from)) {
    throw invalidWalkInput(REASON_WALK_TOO_MANY_SEEDS);
  }
}

function selectParentIds(parents: ReadonlyArray<ObjectId>, order: Order): ReadonlyArray<ObjectId> {
  return order === 'first-parent' && parents.length > 0 ? [parents[0] as ObjectId] : parents;
}

function enqueueParents(
  state: WalkState,
  commit: Commit,
  order: Order,
  bodies: CommitBodies,
): void {
  // Shallow boundary: the commit itself is yielded, but its parents are not
  // walked. Matches canonical git's behavior on a `.git/shallow` repository.
  if (state.shallow.has(commit.id)) return;
  enqueueIds(state, selectParentIds(commit.data.parents, order), bodies);
}

function enqueueIds(state: WalkState, ids: ReadonlyArray<ObjectId>, bodies: CommitBodies): void {
  for (const id of ids) {
    if (state.visited.has(id) || state.missing.has(id) || state.until.has(id)) continue;
    if (state.queued.has(id)) continue;
    if (state.queued.size >= MAX_WALK_QUEUE_SIZE) {
      throw invalidWalkInput(REASON_WALK_QUEUE_OVERFLOW);
    }
    state.queue.push(id);
    state.queued.add(id);
    bodies.start(id);
  }
}

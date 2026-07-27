import { invalidWalkInput, operationAborted } from '../../domain/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { type BoundedReader, createBoundedReader } from './internal/bounded-reader.js';
import { readCommit } from './internal/read-commit.js';
import { commitHeader, DEFAULT_PREFETCH_CONCURRENCY } from './internal/read-commit-graph.js';
import { MAX_WALK_QUEUE_SIZE, type WalkCommitsOptions } from './types.js';
import {
  exceedsMaxWalkSeeds,
  isEmptyFrom,
  REASON_WALK_EMPTY_FROM,
  REASON_WALK_QUEUE_OVERFLOW,
  REASON_WALK_TOO_MANY_SEEDS,
} from './validators.js';

interface WalkState {
  // queue is mutated in-place via push/shift; declared without `readonly` to
  // signal that intent honestly. Sets are also mutated, but Set's API does not
  // require dropping the `readonly` qualifier on the reference.
  queue: ObjectId[];
  readonly visited: Set<string>;
  readonly missing: Set<string>;
  readonly until: Set<ObjectId>;
  readonly shallow: ReadonlySet<ObjectId>;
}

type Order = 'topo' | 'first-parent';
type CommitBodies = BoundedReader<Commit | undefined>;

interface WalkSession {
  readonly state: WalkState;
  readonly bodies: CommitBodies;
  readonly order: Order;
  readonly ignoreMissing: boolean;
}

function createWalkSession(ctx: Context, options: WalkCommitsOptions): WalkSession {
  const order = options.order ?? 'topo';
  const ignoreMissing = options.ignoreMissing ?? false;
  const verifyHash = options.verifyHash ?? true;
  const state: WalkState = {
    queue: [...options.from],
    visited: new Set<string>(),
    missing: new Set<string>(),
    until: new Set(options.until ?? []),
    shallow: options.shallow ?? new Set<ObjectId>(),
  };
  const bound = ctx.config?.parallelism ?? DEFAULT_PREFETCH_CONCURRENCY;
  const bodies: CommitBodies = createBoundedReader(bound, (id) =>
    readCommit(ctx, id, { verifyHash, ignoreMissing, missing: state.missing }),
  );
  // Prime the initial seeds so their reads overlap instead of starting only
  // as each is individually popped.
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

export async function* walkCommits(
  ctx: Context,
  options: WalkCommitsOptions,
): AsyncIterable<Commit> {
  validateOptions(options);
  const session = createWalkSession(ctx, options);
  const { state, bodies, order } = session;

  while (state.queue.length > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    // Caller guards `queue.length > 0`, so shift is guaranteed to return a value.
    const id = state.queue.shift() as ObjectId;
    if (state.visited.has(id) || state.missing.has(id) || state.until.has(id)) continue;

    const { commit, enqueuedFromHeader } = await resolveFrontierEntry(ctx, session, id);
    if (commit === undefined) continue;
    state.visited.add(id);
    yield commit;
    // Graph-absent commit: parents were not yet known, so enqueue now from
    // the just-read body (today's fallback path — unchanged shape).
    if (!enqueuedFromHeader) {
      enqueueParents(state, commit, order, bodies);
    }
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
    if (state.queue.length >= MAX_WALK_QUEUE_SIZE) {
      throw invalidWalkInput(REASON_WALK_QUEUE_OVERFLOW);
    }
    state.queue.push(id);
    bodies.start(id);
  }
}

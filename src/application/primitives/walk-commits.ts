import { invalidWalkInput, operationAborted, TsgitError } from '../../domain/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
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

export async function* walkCommits(
  ctx: Context,
  options: WalkCommitsOptions,
): AsyncIterable<Commit> {
  validateOptions(options);
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

  while (state.queue.length > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    const id = pickNext(state.queue, order);
    if (state.visited.has(id) || state.until.has(id)) continue;

    const commit = await fetchCommit(ctx, id, verifyHash, ignoreMissing, state.missing);
    if (commit === undefined) continue;
    state.visited.add(id);
    yield commit;
    enqueueParents(state, commit, order);
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

async function fetchCommit(
  ctx: Context,
  id: ObjectId,
  verifyHash: boolean,
  ignoreMissing: boolean,
  missing: Set<string>,
): Promise<Commit | undefined> {
  try {
    const object = await readObject(ctx, id, { verifyHash });
    if (object.type !== 'commit') return undefined;
    return object;
  } catch (error) {
    if (ignoreMissing && isObjectNotFound(error)) {
      missing.add(id);
      return undefined;
    }
    throw error;
  }
}

function enqueueParents(state: WalkState, commit: Commit, order: 'topo' | 'first-parent'): void {
  // Shallow boundary: the commit itself is yielded, but its parents are not
  // walked. Matches canonical git's behavior on a `.git/shallow` repository.
  if (state.shallow.has(commit.id)) return;
  const parents =
    order === 'first-parent' && commit.data.parents.length > 0
      ? [commit.data.parents[0] as ObjectId]
      : commit.data.parents;
  for (const parent of parents) {
    if (state.visited.has(parent) || state.missing.has(parent) || state.until.has(parent)) continue;
    if (state.queue.length >= MAX_WALK_QUEUE_SIZE) {
      throw invalidWalkInput(REASON_WALK_QUEUE_OVERFLOW);
    }
    state.queue.push(parent);
  }
}

function pickNext(queue: ObjectId[], _order: 'topo' | 'first-parent'): ObjectId {
  // Caller guards `queue.length > 0`, so shift is guaranteed to return a value.
  // Order arg retained for future heap-based scheduler.
  return queue.shift() as ObjectId;
}

function isObjectNotFound(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'OBJECT_NOT_FOUND';
}

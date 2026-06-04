import { enqueue, type QueueEntry } from '../../domain/commit/priority-queue.js';
import { invalidWalkInput, operationAborted } from '../../domain/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readCommit } from './internal/read-commit.js';
import type { WalkCommitsByDateOptions } from './types.js';
import {
  exceedsMaxWalkSeeds,
  isEmptyFrom,
  REASON_WALK_EMPTY_FROM,
  REASON_WALK_TOO_MANY_SEEDS,
} from './validators.js';

type CommitReader = (id: ObjectId) => Promise<Commit | undefined>;

/** Mutable state threaded through the date-ordered walk. */
interface DateWalk {
  readonly queue: QueueEntry<Commit>[];
  readonly seen: Set<ObjectId>;
  readonly until: Set<ObjectId>;
  readonly read: CommitReader;
}

/**
 * Walk every commit reachable from `from` across **all** parents, yielding them
 * in commit-date priority order — newest committer date first, oid-ascending on
 * ties (the shared `domain/commit` comparator). Unlike `walkCommits`'s lazy FIFO
 * orders, this reads each commit eagerly to order the frontier, carrying the
 * loaded `Commit` through the priority queue.
 *
 * A `seen` set guards enqueue, so each reachable commit is read and yielded at
 * most once and the frontier is bounded by the reachable-commit count. `until`
 * excludes commits before they are read; `shallow` boundaries are yielded but
 * their parents are not walked; `ignoreMissing` / `verifyHash` thread into the
 * shared commit reader; an aborted signal throws at the next loop head.
 *
 * The walk is lazy (parents discovered on pop), so it matches
 * `git rev-list --date-order` for histories whose committer dates are monotonic
 * along parent edges — every history built by normal git operations. It does not
 * enforce git's strict all-children-before-parent rule for forged reverse-causal
 * dates, trading that edge case for streaming composition.
 */
export async function* walkCommitsByDate(
  ctx: Context,
  options: WalkCommitsByDateOptions,
): AsyncIterable<Commit> {
  assertValidSeeds(options.from);
  const shallow = options.shallow ?? new Set<ObjectId>();
  const walk: DateWalk = {
    queue: [],
    seen: new Set<ObjectId>(options.from),
    until: new Set<ObjectId>(options.until ?? []),
    read: makeReader(ctx, options),
  };

  await enqueueSeeds(walk);

  while (walk.queue.length > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    const { value: commit } = walk.queue.shift() as QueueEntry<Commit>;
    yield commit;
    if (shallow.has(commit.id)) continue;
    await enqueueParents(walk, commit);
  }
}

const assertValidSeeds = (from: ReadonlyArray<ObjectId>): void => {
  if (isEmptyFrom(from)) throw invalidWalkInput(REASON_WALK_EMPTY_FROM);
  if (exceedsMaxWalkSeeds(from)) throw invalidWalkInput(REASON_WALK_TOO_MANY_SEEDS);
};

const makeReader = (ctx: Context, options: WalkCommitsByDateOptions): CommitReader => {
  const verifyHash = options.verifyHash ?? true;
  const ignoreMissing = options.ignoreMissing ?? false;
  // `seen` already prevents any re-read, so the reader's missing-memo is inert
  // here; it satisfies the shared contract without a second set.
  const missing = new Set<string>();
  return (id) => readCommit(ctx, id, { verifyHash, ignoreMissing, missing });
};

// Iterate the deduped `seen` set, not raw `from`, so a duplicate seed enqueues
// once — `walkCommits` dedups seeds via its pop-time visited check; this pop loop
// has none by design.
const enqueueSeeds = async (walk: DateWalk): Promise<void> => {
  for (const seed of walk.seen) {
    if (walk.until.has(seed)) continue;
    await enqueueCommit(walk, seed);
  }
};

const enqueueParents = async (walk: DateWalk, commit: Commit): Promise<void> => {
  for (const parent of commit.data.parents) {
    if (walk.seen.has(parent) || walk.until.has(parent)) continue;
    walk.seen.add(parent);
    await enqueueCommit(walk, parent);
  }
};

const enqueueCommit = async (walk: DateWalk, id: ObjectId): Promise<void> => {
  const commit = await walk.read(id);
  if (commit !== undefined) {
    enqueue(walk.queue, { oid: id, date: commit.data.committer.timestamp, value: commit });
  }
};

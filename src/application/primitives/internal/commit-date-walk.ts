import { enqueue, type QueueEntry } from '../../../domain/commit/priority-queue.js';
import { operationAborted } from '../../../domain/error.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readCommit } from './read-commit.js';

type CommitReader = (id: ObjectId) => Promise<Commit | undefined>;

/**
 * One walk step: the popped commit plus the frontier state sampled after the
 * pop and before its parents are enqueued (git describe cond-2 check point).
 */
export type DateWalkStep = {
  readonly commit: Commit;
  readonly frontierEmpty: boolean;
  /** Lazy snapshot of the queued oids; valid until the iterator resumes. */
  readonly frontier: () => ReadonlyArray<ObjectId>;
};

/** Parents this walk follows: the first parent only, or all of them. */
export const selectParents = (commit: Commit, firstParent: boolean): ReadonlyArray<ObjectId> =>
  firstParent ? commit.data.parents.slice(0, 1) : commit.data.parents;

export interface CommitDateWalkOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  /**
   * Commits whose parents must NOT be walked (shallow boundary). The commit
   * itself is still yielded — only its parents are skipped.
   */
  readonly shallow?: ReadonlySet<ObjectId>;
  /** Follow only the first parent through merges (git's `--first-parent`). */
  readonly firstParent?: boolean;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
}

/** Mutable state threaded through the date-ordered walk. */
interface DateWalk {
  readonly queue: QueueEntry<Commit>[];
  readonly seen: Set<ObjectId>;
  readonly until: Set<ObjectId>;
  readonly firstParent: boolean;
  readonly read: CommitReader;
}

/**
 * The shared date-priority commit traversal: walk every commit reachable from
 * `from` (across all parents, or first-parent only) in commit-date priority
 * order — newest committer date first, oid-ascending on ties (the shared
 * `domain/commit` comparator). Each commit is read eagerly to order the frontier
 * and carried through the priority queue.
 *
 * A `seen` set guards enqueue, so each reachable commit is read and yielded at
 * most once and the frontier is bounded by the reachable-commit count. `until`
 * excludes commits before they are read; `shallow` boundaries are yielded but
 * their parents are not walked; `ignoreMissing` / `verifyHash` thread into the
 * shared commit reader; an aborted signal throws at the next loop head.
 *
 * Seeds are assumed already resolved and within bounds — the public
 * `walkCommitsByDate` wrapper owns the `INVALID_WALK_INPUT` seed contract.
 *
 * The walk is lazy (parents discovered on pop), so it matches
 * `git rev-list --date-order` for histories whose committer dates are monotonic
 * along parent edges — every history built by normal git operations. It does not
 * enforce git's strict all-children-before-parent rule for forged reverse-causal
 * dates, trading that edge case for streaming composition.
 */
export async function* commitDateWalk(
  ctx: Context,
  options: CommitDateWalkOptions,
): AsyncIterable<DateWalkStep> {
  const shallow = options.shallow ?? new Set<ObjectId>();
  const walk: DateWalk = {
    queue: [],
    seen: new Set<ObjectId>(options.from),
    until: new Set<ObjectId>(options.until ?? []),
    firstParent: options.firstParent ?? false,
    read: makeReader(ctx, options),
  };

  await enqueueSeeds(walk);

  while (walk.queue.length > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    const { value: commit } = walk.queue.shift() as QueueEntry<Commit>;
    yield {
      commit,
      frontierEmpty: walk.queue.length === 0,
      frontier: () => walk.queue.map((entry) => entry.oid),
    };
    if (shallow.has(commit.id)) continue;
    await enqueueParents(walk, commit);
  }
}

const makeReader = (ctx: Context, options: CommitDateWalkOptions): CommitReader => {
  const verifyHash = options.verifyHash ?? true;
  const ignoreMissing = options.ignoreMissing ?? false;
  // `seen` already prevents any re-read, so the reader's missing-memo is inert
  // here; it satisfies the shared contract without a second set.
  const missing = new Set<string>();
  return (id) => readCommit(ctx, id, { verifyHash, ignoreMissing, missing });
};

// Iterate the deduped `seen` set, not raw `from`, so a duplicate seed enqueues
// once — the pop loop has no visited check by design.
const enqueueSeeds = async (walk: DateWalk): Promise<void> => {
  for (const seed of walk.seen) {
    if (walk.until.has(seed)) continue;
    await enqueueCommit(walk, seed);
  }
};

const enqueueParents = async (walk: DateWalk, commit: Commit): Promise<void> => {
  for (const parent of selectParents(commit, walk.firstParent)) {
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

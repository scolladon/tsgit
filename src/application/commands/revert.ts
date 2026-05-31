/**
 * `revert` — record new commits that undo the changes introduced by existing
 * commits. The inverse of `cherry-pick`: each revert is a new single-parent
 * commit authored by the **current identity** (not the reverted commit's author)
 * whose patch is the **reverse** 3-way merge (`base = C`, `ours = HEAD`,
 * `theirs = parent(C)`) applied through the shared `applyMergeToWorktree`
 * primitive. Conflicts stop with a dedicated `REVERT_HEAD` state; an empty
 * revert (no net change) stops markerless (git has no `--allow-empty`).
 */
import {
  noInitialCommit,
  revertMergeNoMainline,
  workingTreeDirty,
} from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { ConflictType, MergeConflict } from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { AuthorIdentity, FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { applyMergeToWorktree } from '../primitives/apply-merge-to-worktree.js';
import { readConfig } from '../primitives/config-read.js';
import { createCommit } from '../primitives/create-commit.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from '../primitives/internal/repo-state.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeTree } from '../primitives/write-tree.js';
import { conflictMergeMsg } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeMergeMsg } from './internal/merge-state.js';
import { revertMessage, writeRevertHead } from './internal/revert-state.js';

export interface RevertRunInput {
  /** Revisions to revert, in argument order — a commit-ish each. */
  readonly commits: ReadonlyArray<string>;
}

export interface RevertedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

export interface RevertConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type RevertResult =
  | { readonly kind: 'reverted'; readonly commits: ReadonlyArray<RevertedCommit> }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<RevertConflict>;
      readonly remaining: number;
    }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

type RevertOutcome =
  | { readonly kind: 'committed'; readonly id: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<MergeConflict> }
  | { readonly kind: 'empty' };

const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

const subjectOf = (message: string): string => message.split('\n')[0] as string;

/** A merge commit (≥2 parents) cannot be reverted without a chosen mainline (`-m`). */
const isMergeCommit = (cData: CommitData): boolean => cData.parents.length >= 2;

const toConflictList = (conflicts: ReadonlyArray<MergeConflict>): ReadonlyArray<RevertConflict> =>
  conflicts.map((c) => ({ path: c.path, type: c.type }));

/** Resolve the (always symbolic) HEAD branch to its commit, or refuse if unborn. */
const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** The new revert commit's author AND committer is the current identity (config `user.*`, now). */
const resolveCurrentIdentity = async (ctx: Context): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const user = config.user;
  const configUser =
    user !== undefined
      ? {
          name: user.name,
          email: user.email,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: '+0000',
        }
      : undefined;
  return resolveCommitter(configUser !== undefined ? { configUser } : {});
};

/** The empty tree (`theirs` of a root-commit revert): materialised so it can be read. */
const emptyTree = (ctx: Context): Promise<ObjectId> => writeTree(ctx, []);

/** Build the new single-parent revert commit; returns its id and message subject (reflog). */
const buildRevertCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
): Promise<{ readonly id: ObjectId; readonly subject: string }> => {
  const identity = await resolveCurrentIdentity(ctx);
  const message = sanitizeMessage(revertMessage(cData, source), { allowEmpty: false });
  const id = await createCommit(ctx, {
    tree,
    parents: [parentId],
    author: identity,
    committer: identity,
    message,
    extraHeaders: [],
  });
  return { id, subject: subjectOf(message) };
};

/** Apply one commit's reverse change onto `ourId`, committing when the merge is clean. */
const applyOneRevert = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  branch: RefName,
  ourId: ObjectId,
): Promise<RevertOutcome> => {
  const parentId = cData.parents[0];
  const theirsTree = parentId !== undefined ? await treeOf(ctx, parentId) : await emptyTree(ctx);
  const oursTree = await treeOf(ctx, ourId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const res = await applyMergeToWorktree(ctx, {
      baseTree: cData.tree,
      oursTree,
      theirsTree,
      currentIndex,
    });
    if (res.kind === 'would-overwrite') throw workingTreeDirty(res.paths);
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    if (res.mergedTree === oursTree) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries);
    const { id, subject } = await buildRevertCommit(ctx, source, cData, ourId, res.mergedTree);
    await updateRef(ctx, branch, id, { expected: ourId, reflogMessage: `revert: ${subject}` });
    return { kind: 'committed', id };
  } finally {
    await lock.release();
  }
};

/** Persist single-revert conflict state (`REVERT_HEAD` + the `Revert "…"` MERGE_MSG). */
const persistStop = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<void> => {
  await writeRevertHead(ctx, source);
  await writeMergeMsg(
    ctx,
    conflictMergeMsg(
      revertMessage(cData, source),
      conflicts.map((c) => c.path),
    ),
  );
};

/**
 * Drive the revert work-list from `startOurId`, committing each clean revert and
 * advancing HEAD. A conflict persists `REVERT_HEAD` + `MERGE_MSG` and stops; an
 * empty revert stops markerless (git has no `--allow-empty`).
 */
const runSequence = async (
  ctx: Context,
  todo: ReadonlyArray<ObjectId>,
  branch: RefName,
  startOurId: ObjectId,
): Promise<RevertResult> => {
  let ourId = startOurId;
  const applied: RevertedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const cData = await readCommitData(ctx, source);
    if (isMergeCommit(cData)) throw revertMergeNoMainline(source);
    const outcome = await applyOneRevert(ctx, source, cData, branch, ourId);
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      ourId = outcome.id;
      continue;
    }
    const remaining = todo.length - (i + 1);
    if (outcome.kind === 'conflict') {
      await persistStop(ctx, source, cData, outcome.conflicts);
      return {
        kind: 'conflict',
        commit: source,
        conflicts: toConflictList(outcome.conflicts),
        remaining,
      };
    }
    return { kind: 'empty', commit: source, remaining };
  }
  return { kind: 'reverted', commits: applied };
};

/** Resolve each argument to a commit oid (single commit-ish per argument). */
const expandRevisions = async (
  ctx: Context,
  args: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> => {
  const todo: ObjectId[] = [];
  for (const arg of args) {
    todo.push(await resolveCommitIsh(ctx, arg));
  }
  return todo;
};

export const revertRun = async (ctx: Context, input: RevertRunInput): Promise<RevertResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'revert');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('revert', 'cannot revert with detached HEAD');
  }
  const ourId = await resolveHeadCommit(ctx, head.target);
  const todo = await expandRevisions(ctx, input.commits);
  await assertCleanWorkTree(ctx, await treeOf(ctx, ourId));
  return runSequence(ctx, todo, head.target, ourId);
};

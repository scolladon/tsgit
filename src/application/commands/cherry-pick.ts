/**
 * `cherry-pick` — apply the change introduced by one or more commits onto the
 * current branch as new single-parent commits, preserving each source commit's
 * author and message (the committer becomes the current identity). The patch is
 * a 3-way merge (`base = parent(C)`, `ours = HEAD`, `theirs = C`) via the shared
 * `applyMergeToWorktree` primitive. Conflicts and empty picks stop with a
 * dedicated `CHERRY_PICK_HEAD` state (distinct from the merge machine).
 */
import { noInitialCommit, workingTreeDirty } from '../../domain/commands/error.js';
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
import { conflictMergeMsg, writeCherryPickHead } from './internal/cherry-pick-state.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeMergeMsg } from './internal/merge-state.js';

export interface CherryPickRunInput {
  /** Revisions to pick, in argument order (single commit-ish each; ranges in a later phase). */
  readonly commits: ReadonlyArray<string>;
  /** -x: append `(cherry picked from commit <oid>)` to each commit message. */
  readonly recordOrigin?: boolean;
}

export interface CherryPickedCommit {
  readonly source: ObjectId;
  readonly created: ObjectId;
}

export interface CherryPickConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type CherryPickResult =
  | { readonly kind: 'picked'; readonly commits: ReadonlyArray<CherryPickedCommit> }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<CherryPickConflict>;
      readonly remaining: number;
    }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

type PickOutcome =
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

/** git's `-x` footer: a blank line then `(cherry picked from commit <full-oid>)`. */
const appendCherryPickOrigin = (message: string, source: ObjectId): string =>
  `${message.replace(/\s+$/, '')}\n\n(cherry picked from commit ${source})`;

/** The message a pick will commit: the source message, optionally `-x`-stamped. */
const messageDraft = (message: string, source: ObjectId, recordOrigin: boolean): string =>
  recordOrigin ? appendCherryPickOrigin(message, source) : message;

/** Resolve the (always symbolic — detached is refused upstream) HEAD branch to
 *  its commit oid, or refuse on an unborn branch. */
const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};

/** The committer is the current identity (config `user.*`, now) — not the picked author. */
const resolvePickCommitter = async (ctx: Context): Promise<AuthorIdentity> => {
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

/** Build the new commit: preserved author + message, current committer, single parent. */
const createPickCommit = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  parentId: ObjectId,
  tree: ObjectId,
  recordOrigin: boolean,
): Promise<ObjectId> => {
  const committer = await resolvePickCommitter(ctx);
  return createCommit(ctx, {
    tree,
    parents: [parentId],
    author: cData.author,
    committer,
    message: sanitizeMessage(messageDraft(cData.message, source, recordOrigin), {
      allowEmpty: false,
    }),
    extraHeaders: [],
  });
};

/** Apply one commit's change onto `ourId`, committing it when the merge is clean. */
const applyOnePick = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  branch: RefName,
  ourId: ObjectId,
  recordOrigin: boolean,
): Promise<PickOutcome> => {
  const parentId = cData.parents[0];
  const baseTree = parentId !== undefined ? await treeOf(ctx, parentId) : undefined;
  const oursTree = await treeOf(ctx, ourId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const res = await applyMergeToWorktree(ctx, {
      baseTree,
      oursTree,
      theirsTree: cData.tree,
      currentIndex,
    });
    if (res.kind === 'would-overwrite') throw workingTreeDirty(res.paths);
    if (res.kind === 'conflict') {
      await lock.commit(res.indexEntries);
      return { kind: 'conflict', conflicts: res.conflicts };
    }
    if (res.mergedTree === oursTree) return { kind: 'empty' };
    await lock.commit(res.result.newIndexEntries);
    const id = await createPickCommit(ctx, source, cData, ourId, res.mergedTree, recordOrigin);
    await updateRef(ctx, branch, id, {
      expected: ourId,
      reflogMessage: `cherry-pick: ${subjectOf(cData.message)}`,
    });
    return { kind: 'committed', id };
  } finally {
    await lock.release();
  }
};

/** Persist single-pick stop state (`CHERRY_PICK_HEAD` + `MERGE_MSG`). */
const persistStop = async (
  ctx: Context,
  source: ObjectId,
  cData: CommitData,
  conflicts: ReadonlyArray<MergeConflict> | undefined,
  recordOrigin: boolean,
): Promise<void> => {
  await writeCherryPickHead(ctx, source);
  const draft = messageDraft(cData.message, source, recordOrigin);
  const message =
    conflicts !== undefined && conflicts.length > 0
      ? conflictMergeMsg(
          draft,
          conflicts.map((c) => c.path),
        )
      : draft;
  await writeMergeMsg(ctx, message);
};

export const cherryPickRun = async (
  ctx: Context,
  input: CherryPickRunInput,
): Promise<CherryPickResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'cherry-pick');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('cherry-pick', 'cannot cherry-pick with detached HEAD');
  }
  let ourId = await resolveHeadCommit(ctx, head.target);
  const todo: ObjectId[] = [];
  for (const arg of input.commits) todo.push(await resolveCommitIsh(ctx, arg));
  await assertCleanWorkTree(ctx, await treeOf(ctx, ourId));
  const recordOrigin = input.recordOrigin ?? false;

  const applied: CherryPickedCommit[] = [];
  for (let i = 0; i < todo.length; i += 1) {
    const source = todo[i] as ObjectId;
    const cData = await readCommitData(ctx, source);
    const outcome = await applyOnePick(ctx, source, cData, head.target, ourId, recordOrigin);
    if (outcome.kind === 'committed') {
      applied.push({ source, created: outcome.id });
      ourId = outcome.id;
      continue;
    }
    await persistStop(
      ctx,
      source,
      cData,
      outcome.kind === 'conflict' ? outcome.conflicts : undefined,
      recordOrigin,
    );
    const remaining = todo.length - (i + 1);
    if (outcome.kind === 'conflict') {
      return {
        kind: 'conflict',
        commit: source,
        conflicts: outcome.conflicts.map((c) => ({ path: c.path, type: c.type })),
        remaining,
      };
    }
    return { kind: 'empty', commit: source, remaining };
  }
  return { kind: 'picked', commits: applied };
};

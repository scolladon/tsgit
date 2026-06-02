/**
 * Helpers shared by the history-rewriting porcelain (`cherry-pick`, `revert`,
 * `rebase`): read a commit's data, project its tree, take a message subject, and
 * guard a symbolic HEAD. Each replay command consumes the same building blocks,
 * so they live here rather than being copied per command.
 */
import { unsupportedOperation } from '../../../domain/index.js';
import type { CommitData } from '../../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readHeadRaw } from '../../primitives/internal/repo-state.js';
import { readObject } from '../../primitives/read-object.js';

export const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

export const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

export const subjectOf = (message: string): string => message.split('\n')[0] as string;

/** Read the symbolic HEAD branch, refusing a detached HEAD for `verb`. */
export const requireSymbolicHead = async (ctx: Context, verb: string): Promise<RefName> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation(verb, 'cannot run with detached HEAD');
  }
  return head.target;
};

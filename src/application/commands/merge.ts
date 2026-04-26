import { nonFastForward } from '../../domain/commands/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { createCommit } from '../primitives/create-commit.js';
import { mergeBase } from '../primitives/merge-base.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { resolveAuthor, resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { readConfig } from './internal/config-read.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';

export interface MergeOptions {
  readonly target: string;
  readonly message?: string;
  readonly fastForwardOnly?: boolean;
  readonly noFastForward?: boolean;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

export type MergeResult =
  | { readonly kind: 'up-to-date'; readonly id: ObjectId }
  | { readonly kind: 'fast-forward'; readonly id: ObjectId; readonly branch: RefName }
  | {
      readonly kind: 'merge';
      readonly id: ObjectId;
      readonly branch: RefName;
      readonly parents: ReadonlyArray<ObjectId>;
    };

/**
 * Merge `target` into the current HEAD branch. v1 supports:
 * - Up-to-date detection (target is ancestor of HEAD).
 * - Fast-forward (HEAD is ancestor of target → branch advances).
 * - True merge for diverged histories: writes a merge commit using HEAD's tree
 *   (callers must run `add` to incorporate target's content). Conflict
 *   resolution and three-way tree merge land in Phase 11.
 */
export const merge = async (ctx: Context, opts: MergeOptions): Promise<MergeResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'merge');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('merge', 'cannot merge with detached HEAD');
  }
  const ourId = await resolveRef(ctx, head.target);
  const theirId = await resolveTarget(ctx, opts.target);
  if (ourId === theirId) return { kind: 'up-to-date', id: ourId };
  const base = await mergeBase(ctx, ourId, theirId);
  if (base === theirId) return { kind: 'up-to-date', id: ourId };
  if (base === ourId) {
    if (opts.noFastForward !== true) {
      await updateRef(ctx, head.target, theirId, { expected: ourId });
      return { kind: 'fast-forward', id: theirId, branch: head.target };
    }
  }
  if (opts.fastForwardOnly === true) {
    throw nonFastForward(head.target, ourId, theirId);
  }
  const config = await readConfig(ctx);
  const cfgUser = config.user
    ? {
        name: config.user.name,
        email: config.user.email,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: '+0000',
      }
    : undefined;
  const authorInput: { explicit?: AuthorIdentity; configUser?: AuthorIdentity } = {};
  if (opts.author !== undefined) authorInput.explicit = opts.author;
  if (cfgUser !== undefined) authorInput.configUser = cfgUser;
  const author = resolveAuthor(authorInput);
  const committerInput: {
    explicit?: AuthorIdentity;
    author?: AuthorIdentity;
    configUser?: AuthorIdentity;
  } = { author };
  if (opts.committer !== undefined) committerInput.explicit = opts.committer;
  if (cfgUser !== undefined) committerInput.configUser = cfgUser;
  const committer = resolveCommitter(committerInput);
  const ourTree = await getTree(ctx, ourId);
  const message = sanitizeMessage(opts.message ?? `Merge ${opts.target}`, { allowEmpty: false });
  const commitData: CommitData = {
    tree: ourTree,
    parents: [ourId, theirId],
    author,
    committer,
    message,
    extraHeaders: [],
  };
  const id = await createCommit(ctx, commitData);
  await updateRef(ctx, head.target, id, { expected: ourId });
  return { kind: 'merge', id, branch: head.target, parents: [ourId, theirId] };
};

const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  return resolveRef(ctx, `refs/heads/${target}` as RefName);
};

const getTree = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};

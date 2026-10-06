/**
 * git's `MERGE_AUTOSTASH`: the stash `merge --autostash` made of a dirty tree,
 * applied when the merge concludes or is aborted, saved to the stash list when
 * the merge state is otherwise removed.
 *
 * @writes
 *   surface: branch-state
 *   kind:    byte-identical
 *   format:  git-merge-state-files
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import { MERGE_AUTOSTASH } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { pushStashRef } from '../../primitives/stash-ref.js';
import { readOptionalOidFile } from './oid-file.js';

const autostashPath = (ctx: Context): string => `${ctx.layout.gitDir}/${MERGE_AUTOSTASH}`;

export const writeMergeAutostash = (ctx: Context, stash: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(autostashPath(ctx), `${stash}\n`);

/** Read and delete `MERGE_AUTOSTASH`, as git's `apply_save_autostash_ref` consumes it. */
export const takeMergeAutostash = async (ctx: Context): Promise<ObjectId | undefined> => {
  const stash = await readOptionalOidFile(ctx, autostashPath(ctx));
  if (stash !== undefined) await ctx.fs.rm(autostashPath(ctx));
  return stash;
};

/** git's `save_autostash_ref`: keep the autostash in `refs/stash` rather than apply it. */
export const saveMergeAutostash = async (ctx: Context): Promise<void> => {
  const stash = await takeMergeAutostash(ctx);
  if (stash === undefined) return;
  await pushStashRef(ctx, stash, AUTOSTASH_MESSAGE);
  ctx.logger?.info?.(AUTOSTASH_SAVED);
};

const AUTOSTASH_MESSAGE = 'autostash';

const AUTOSTASH_SAVED =
  'Autostash exists; creating a new stash entry.\n' +
  'Your changes are safe in the stash.\n' +
  'You can run "git stash pop" or "git stash drop" at any time.';

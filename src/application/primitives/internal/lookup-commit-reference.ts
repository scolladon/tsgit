import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

/**
 * git's `lookup_commit_reference`: peel `id` through its annotated tags to the
 * commit it names, or report — on `error:`, naming `id` as given and the kind
 * the chain reached — that it names none and answer `undefined`.
 */
export const lookupCommitReference = async (
  ctx: Context,
  id: ObjectId,
): Promise<Commit | undefined> => {
  let obj = await readObject(ctx, id);
  while (obj.type === 'tag') obj = await readObject(ctx, obj.data.object);
  if (obj.type === 'commit') return obj;
  ctx.logger?.error?.(`object ${id} is a ${obj.type}, not a commit`, { id, type: obj.type });
  return undefined;
};

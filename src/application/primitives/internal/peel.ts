import { objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

/**
 * Peel an object id to the requested kind: follow annotated tags (≤ 5 levels) to
 * their target, return the id once a `commit`/`tree`/`blob`/`tag` of that kind is
 * reached, and for the `tree` target take a commit's root tree. A rev that cannot
 * reach the wanted kind refuses with `OBJECT_NOT_FOUND`. Shared by the rev grammar
 * (`rev-parse`) and the read-command resolver (`resolve-rev`).
 */
export const peel = async (
  ctx: Context,
  id: ObjectId,
  target: 'commit' | 'tree' | 'blob' | 'tag',
): Promise<ObjectId> => {
  let current: ObjectId = id;
  for (let i = 0; i < 5; i += 1) {
    const obj = await readObject(ctx, current);
    if (obj.type === target) return current;
    if (obj.type === 'tag') {
      current = obj.data.object;
      continue;
    }
    if (target === 'tree' && obj.type === 'commit') return obj.data.tree;
    throw objectNotFound(current);
  }
  throw objectNotFound(current);
};

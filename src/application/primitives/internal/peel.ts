import { objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

type PeelTarget = 'commit' | 'tree' | 'blob' | 'tag';

/**
 * Peel an object id to the requested kind, as git's `repo_peel_to_type`: follow
 * annotated tags (≤ 5 levels) and a commit's root tree until an object of that
 * kind is reached. A rev that cannot reach the wanted kind refuses with
 * `OBJECT_NOT_FOUND`; under a `name` (a `<rev>^{<type>}` operator) git first
 * reports the kind it stopped at. Shared by the rev grammar (`rev-parse`) and
 * the read-command resolver (`resolve-rev`).
 */
export const peel = async (
  ctx: Context,
  id: ObjectId,
  target: PeelTarget,
  name?: string,
): Promise<ObjectId> => {
  let current: ObjectId = id;
  for (let i = 0; i < 5; i += 1) {
    const obj = await readObject(ctx, current);
    if (obj.type === target) return current;
    if (obj.type === 'tag') {
      current = obj.data.object;
      continue;
    }
    if (obj.type === 'commit') {
      if (target === 'tree') return obj.data.tree;
      current = obj.data.tree;
      continue;
    }
    if (name !== undefined) reportPeelMismatch(ctx, name, target, obj.type);
    throw objectNotFound(current);
  }
  throw objectNotFound(current);
};

const reportPeelMismatch = (
  ctx: Context,
  name: string,
  target: PeelTarget,
  reached: string,
): void => {
  ctx.logger?.error?.(
    `${name}: expected ${target} type, but the object dereferences to ${reached} type`,
    { name, expected: target, type: reached },
  );
};

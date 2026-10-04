import { objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type ObjectTypeTable, parseTypedObject } from './object-type-table.js';

type PeelTarget = 'commit' | 'tree' | 'blob' | 'tag';

/**
 * Peel an object id to the requested kind, as git's `repo_peel_to_type`: follow
 * annotated tags, to any depth, and a commit's root tree until an object of that
 * kind is reached. A rev that cannot reach the wanted kind refuses with
 * `OBJECT_NOT_FOUND`; under a `name` (a `<rev>^{<type>}` operator) git first
 * reports the kind it stopped at. A chain revisiting an object — only a store
 * whose objects do not hash to their names holds one — names no object either.
 * Shared by the rev grammar (`rev-parse`) and the read-command resolver
 * (`resolve-rev`). Each object is typed into `table`, the invocation's.
 */
export const peel = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  target: PeelTarget,
  name?: string,
): Promise<ObjectId> => {
  const seen = new Set<ObjectId>();
  for (let current = id; !seen.has(current); ) {
    seen.add(current);
    const obj = await parseTypedObject(ctx, table, current);
    if (obj === undefined) throw objectNotFound(current);
    if (obj.type === target) return current;
    if (obj.type === 'tag') {
      current = obj.data.object;
      continue;
    }
    if (obj.type === 'commit') {
      current = obj.data.tree;
      continue;
    }
    if (name !== undefined) reportPeelMismatch(ctx, name, target, obj.type);
    throw objectNotFound(current);
  }
  throw objectNotFound(id);
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

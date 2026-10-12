import { objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import {
  type ObjectTypeTable,
  type PeelHopObject,
  parseTypedPeelHop,
} from './object-type-table.js';
import { walkPeelChain } from './peel-chain.js';

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
  const read = (oid: ObjectId) => parseTypedPeelHop(ctx, table, oid);
  const nextHop = (obj: PeelHopObject | undefined) => hopToward(obj, target);
  const walk = await walkPeelChain({ id, result: await read(id) }, read, nextHop);
  if (walk.end !== 'reached') throw objectNotFound(id);
  const reached = walk.result;
  if (reached === undefined) throw objectNotFound(walk.id);
  if (reached.type === target) return walk.id;
  if (name !== undefined) reportPeelMismatch(ctx, name, target, reached.type);
  throw objectNotFound(walk.id);
};

/** A tag hops to its target and a commit to its root tree, until `target` is reached. */
const hopToward = (obj: PeelHopObject | undefined, target: PeelTarget): ObjectId | undefined => {
  if (obj === undefined || obj.type === target) return undefined;
  if (obj.type === 'tag') return obj.data.object;
  if (obj.type === 'commit') return obj.data.tree;
  return undefined;
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

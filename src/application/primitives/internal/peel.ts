import { errorDataCode } from '../../../domain/error-data-code.js';
import { objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { isBlobByHeader } from './object-emit.js';
import {
  assignObjectType,
  type ObjectTypeTable,
  type PeelHopObject,
  parseTypedPeelHop,
} from './object-type-table.js';
import { type PeelWalk, walkPeelChain } from './peel-chain.js';

const INVALID_OBJECT_ID = 'INVALID_OBJECT_ID';

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
  const walk = await walkToward(ctx, table, id, target);
  const reached = walk.result;
  if (reached === undefined) throw objectNotFound(walk.id);
  if (reached.type === target) return walk.id;
  if (name !== undefined) reportPeelMismatch(ctx, name, target, reached.type);
  throw objectNotFound(walk.id);
};

export type SearchableKind = 'tree' | 'blob';

export interface SearchableObject {
  readonly kind: SearchableKind;
  readonly id: ObjectId;
}

/**
 * git grep's object dispatch (`deref_tag`, then a commit read as its root
 * tree): tags are followed to any depth, a tree or a blob is kept as it is,
 * and a commit whose tree header names a blob refuses.
 */
export const peelToTreeOrBlob = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
): Promise<SearchableObject> => {
  const walk = await walkToward(ctx, table, id, 'tree');
  const kind = walk.result?.type;
  if (kind === 'tree') return { kind, id: walk.id };
  // A commit's root is read as a tree: git refuses a blob its tree header names.
  if (kind === 'blob' && walk.crossed.last?.type !== 'commit') return { kind, id: walk.id };
  throw objectNotFound(walk.id);
};

/** The walk toward `target`; a chain that does not end `reached` names no object. */
const walkToward = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  target: PeelTarget,
): Promise<PeelWalk<PeelHopObject | undefined>> => {
  const read = (oid: ObjectId) => readHop(ctx, table, oid);
  const nextHop = (obj: PeelHopObject | undefined) => hopToward(obj, target);
  const walk = await walkPeelChain({ id, result: await read(id) }, read, nextHop);
  if (walk.end !== 'reached') throw objectNotFound(id);
  return walk;
};

/**
 * One hop's object. git's `peel_object` types a blob through `oid_object_info`,
 * never its body, so a blob answers from its header alone. A tag whose `object`
 * line does not parse names no object, as git's `parse_object` answering NULL.
 */
const readHop = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  oid: ObjectId,
): Promise<PeelHopObject | undefined> => {
  if (!(await isBlobByHeader(ctx, oid))) return parseUnlessMalformed(ctx, table, oid);
  return assignObjectType(ctx, table, oid, 'blob') ? { type: 'blob' } : undefined;
};

const parseUnlessMalformed = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  oid: ObjectId,
): Promise<PeelHopObject | undefined> => {
  try {
    return await parseTypedPeelHop(ctx, table, oid);
  } catch (error) {
    if (errorDataCode(error) === INVALID_OBJECT_ID) return undefined;
    throw error;
  }
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

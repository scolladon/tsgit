/**
 * git's process-wide object table, scoped to one command invocation: the
 * type each `lookup_<type>` call assigned an id — by a tag's `type` header or
 * by parsing the object itself. A later assignment that disagrees is git's
 * `object X is a <known>, not a <asked>` failure. Each command entry creates
 * its own and threads it down, as each git command runs in its own process;
 * a lookup given none (a primitive called outside a typing command) assigns
 * nothing and never conflicts.
 */
import type { GitObject, ObjectId, ObjectType, Tag } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

export type ObjectTypeTable = Map<ObjectId, ObjectType>;

/** A fresh, empty table for one command invocation. */
export const createObjectTypeTable = (): ObjectTypeTable => new Map();

/**
 * git's `lookup_<type>`: records `type` for `id` unless an earlier lookup
 * typed it otherwise — then logs git's `error:` and answers `false`.
 */
export const assignObjectType = (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  type: ObjectType,
): boolean => {
  const known = table?.get(id);
  if (known === undefined || known === type) {
    table?.set(id, type);
    return true;
  }
  ctx.logger?.error?.(`object ${id} is a ${known}, not a ${type}`, { id, known, type });
  return false;
};

/** git's `parse_tag_buffer`: the tag's `type` header assigns its target's type. */
const assignTagPointer = (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  tag: Tag,
): boolean => {
  const target = tag.data.object;
  if (assignObjectType(ctx, table, target, tag.data.objectType)) return true;
  ctx.logger?.error?.(`bad tag pointer to ${target} in ${id}`, { id, target });
  return false;
};

/**
 * git's `parse_object` against the table: the object read and typed as
 * stored — a tag also typing its target as declared — or `undefined` once
 * either typing conflicted and git's `error:` lines are logged.
 */
export const parseTypedObject = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
): Promise<GitObject | undefined> => {
  const object = await readObject(ctx, id);
  if (!assignObjectType(ctx, table, id, object.type)) return undefined;
  if (object.type === 'tag' && !assignTagPointer(ctx, table, id, object)) return undefined;
  return object;
};

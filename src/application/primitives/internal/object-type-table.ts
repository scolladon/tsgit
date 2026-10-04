/**
 * git's process-wide object table, scoped to one command invocation: the
 * type each `lookup_<type>` call assigned an id — by a tag's `type` header or
 * by parsing the object itself. A later assignment that disagrees is git's
 * `object X is a <known>, not a <asked>` failure. A Context without a table
 * (a primitive called outside a scoped command) assigns nothing and never
 * conflicts.
 */
import type { GitObject, ObjectId, ObjectType, Tag } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

const tables = new WeakMap<Context, Map<ObjectId, ObjectType>>();

/**
 * Runs one command invocation with a fresh, empty table on `ctx`, dropped when
 * it settles. The Context keeps its identity, so caches keyed on it survive.
 * An invocation starting while another on the same Context is in flight
 * joins that one's table.
 */
export const withObjectTypeTable = async <T>(ctx: Context, run: () => Promise<T>): Promise<T> => {
  if (tables.has(ctx)) return run();
  tables.set(ctx, new Map());
  try {
    return await run();
  } finally {
    tables.delete(ctx);
  }
};

/**
 * git's `lookup_<type>`: records `type` for `id` unless an earlier lookup
 * typed it otherwise — then logs git's `error:` and answers `false`.
 */
export const assignObjectType = (ctx: Context, id: ObjectId, type: ObjectType): boolean => {
  const table = tables.get(ctx);
  const known = table?.get(id);
  if (known === undefined || known === type) {
    table?.set(id, type);
    return true;
  }
  ctx.logger?.error?.(`object ${id} is a ${known}, not a ${type}`, { id, known, type });
  return false;
};

/** git's `parse_tag_buffer`: the tag's `type` header assigns its target's type. */
const assignTagPointer = (ctx: Context, id: ObjectId, tag: Tag): boolean => {
  const target = tag.data.object;
  if (assignObjectType(ctx, target, tag.data.objectType)) return true;
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
  id: ObjectId,
): Promise<GitObject | undefined> => {
  const object = await readObject(ctx, id);
  if (!assignObjectType(ctx, id, object.type)) return undefined;
  if (object.type === 'tag' && !assignTagPointer(ctx, id, object)) return undefined;
  return object;
};

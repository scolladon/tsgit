/**
 * git's `get_reference`: a walk tip's object is parsed before the walk sees
 * it, so an absent one — or one whose typing conflicts with what the command
 * already assigned — dies `bad object <name>`, `name` as the argument or ref
 * spelt it, never the id it resolved to.
 */
import { isObjectNotFound, objectNotFound } from '../../../domain/objects/error.js';
import type { GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import {
  type ObjectTypeTable,
  parseTypedObject,
} from '../../primitives/internal/object-type-table.js';

const parseNamed = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  name: string,
  id: ObjectId,
): Promise<GitObject | undefined> => {
  try {
    return await parseTypedObject(ctx, table, id);
  } catch (error) {
    if (isObjectNotFound(error)) throw objectNotFound(name as ObjectId);
    throw error;
  }
};

/**
 * Refuses `OBJECT_NOT_FOUND` naming `name` unless `id` is stored — or, in a
 * partial clone, fetched from the promisor as `parse_object` would — and
 * types as the command's earlier lookups — recorded in `table` — allow.
 */
export const requireReference = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  name: string,
  id: ObjectId,
): Promise<void> => {
  if ((await parseNamed(ctx, table, name, id)) === undefined)
    throw objectNotFound(name as ObjectId);
};

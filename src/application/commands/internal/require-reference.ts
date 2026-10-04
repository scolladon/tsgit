/**
 * git's `get_reference`: a walk tip's object is parsed before the walk sees
 * it, so an absent one dies `bad object <name>` — `name` as the argument or
 * ref spelt it, never the id it resolved to.
 */
import { isObjectNotFound, objectNotFound } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type HasObjectOptions, hasObject } from '../../primitives/has-object.js';
import { readObject } from '../../primitives/read-object.js';

/** `parse_object` reads with a pack re-scan on a miss. */
const RECHECK: HasObjectOptions = { mode: 'recheck' };

/**
 * Refuses `OBJECT_NOT_FOUND` naming `name` unless `id` is stored — or, in a
 * partial clone, fetched from the promisor as `parse_object` would.
 */
export const requireReference = async (ctx: Context, name: string, id: ObjectId): Promise<void> => {
  if (await hasObject(ctx, id, RECHECK)) return;
  try {
    await readObject(ctx, id);
  } catch (error) {
    if (isObjectNotFound(error)) throw objectNotFound(name as ObjectId);
    throw error;
  }
};

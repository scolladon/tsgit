import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { Blob, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import type { ReadObjectOptions } from './types.js';

export async function readBlob(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<Blob> {
  const object = await readObject(ctx, id, options);
  if (object.type !== 'blob') {
    throw unexpectedObjectType('blob', object.type, id);
  }
  return object;
}

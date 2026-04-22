import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName, Tree } from '../../domain/objects/index.js';
import { refChainTooDeep } from '../../domain/refs/error.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { resolveRef } from './resolve-ref.js';
import { MAX_PEEL_DEPTH } from './types.js';
import { looksLikeObjectId } from './validators.js';

export async function readTree(ctx: Context, ref: RefName | ObjectId): Promise<Tree> {
  const startId: ObjectId = looksLikeObjectId(ref as string)
    ? (ref as ObjectId)
    : await resolveRef(ctx, ref as RefName);
  let currentId: ObjectId = startId;
  let object = await readObject(ctx, currentId);
  let depth = 0;
  while (object.type === 'commit' || object.type === 'tag') {
    depth += 1;
    if (depth > MAX_PEEL_DEPTH) {
      throw refChainTooDeep(depth, []);
    }
    currentId = object.type === 'commit' ? object.data.tree : object.data.object;
    object = await readObject(ctx, currentId);
  }
  if (object.type !== 'tree') {
    throw unexpectedObjectType('tree', object.type, currentId);
  }
  return object;
}

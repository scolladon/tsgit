import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName, Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { peelChain } from './internal/peel-chain.js';
import { readObject } from './read-object.js';
import { resolveRef } from './resolve-ref.js';
import { looksLikeObjectId } from './validators.js';

export async function readTree(ctx: Context, ref: RefName | ObjectId): Promise<Tree> {
  const startId: ObjectId = looksLikeObjectId(ref as string)
    ? (ref as ObjectId)
    : await resolveRef(ctx, ref as RefName);
  const { id, result } = await peelChain(ctx, startId, readObject, (object) => {
    if (object.type === 'commit') return object.data.tree;
    if (object.type === 'tag') return object.data.object;
    return undefined;
  });
  if (result.type !== 'tree') {
    throw unexpectedObjectType('tree', result.type, id);
  }
  return result;
}

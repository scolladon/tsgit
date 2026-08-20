import { unexpectedObjectType } from '../../domain/objects/error.js';
import { isOid, type ObjectId, type RefName, type Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { peelChain } from './internal/peel-chain.js';
import { readObject } from './read-object.js';
import { resolveRef } from './resolve-ref.js';

export async function readTree(ctx: Context, ref: RefName | ObjectId): Promise<Tree> {
  const startId: ObjectId = isOid(ref as string, ctx.hashConfig)
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

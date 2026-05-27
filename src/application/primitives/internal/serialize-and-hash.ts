import { type GitObject, type ObjectId, serializeObject } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

/**
 * Serialise a `GitObject` to its canonical on-disk byte form (header
 * `<type> <size>\0<payload>`) and compute its OID under the active
 * hash configuration.
 *
 * Shared by `writeObject` (the loose-object writer) and `hashBlob`
 * (the pure / writeable blob hasher) so both call sites produce
 * byte-identical OIDs for identical input.
 *
 * @internal — not re-exported from `primitives/index.ts`.
 */
export const serializeAndHash = async (
  ctx: Context,
  object: GitObject,
): Promise<{ readonly bytes: Uint8Array; readonly id: ObjectId }> => {
  const bytes = serializeObject(object, ctx.hashConfig);
  const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
  return { bytes, id };
};

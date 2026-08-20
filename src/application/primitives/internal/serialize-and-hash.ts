import {
  type GitObject,
  invalidObjectId,
  isOid,
  type ObjectId,
  serializeObject,
} from '../../../domain/objects/index.js';
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
 * The returned hex is checked against `ctx.hashConfig` with `isOid` (a
 * single `RegExp.test` — this is a hot path) before being trusted as an
 * `ObjectId`, rather than cast unchecked: a hash service whose output width
 * disagrees with the repository's declared algorithm must fail loudly here,
 * the only place a written id's width is checked against the declared width.
 *
 * @internal — not re-exported from `primitives/index.ts`.
 */
export const serializeAndHash = async (
  ctx: Context,
  object: GitObject,
): Promise<{ readonly bytes: Uint8Array; readonly id: ObjectId }> => {
  const bytes = serializeObject(object, ctx.hashConfig);
  const hex = await ctx.hash.hashHex(bytes);
  if (!isOid(hex, ctx.hashConfig)) {
    throw invalidObjectId(hex);
  }
  return { bytes, id: hex as ObjectId };
};

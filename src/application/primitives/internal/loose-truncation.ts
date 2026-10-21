import { bytesEqual } from '../../../domain/objects/encoding.js';
import { classifyLooseBody } from '../../../domain/objects/git-object.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { inflateLooseBuffered, looseCompressedBytes } from '../object-resolver.js';

/**
 * Whether the primary's loose copy of `id` is a window truncation (git's buffered
 * `unpack_loose_rest`) whose claimed prefix is exactly `packed`.
 */
export async function isLooseTruncationOf(
  ctx: Context,
  id: ObjectId,
  packed: Uint8Array,
): Promise<boolean> {
  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed === undefined) return false;
  const { split } = await inflateLooseBuffered(ctx, id, compressed);
  if (classifyLooseBody(split) !== 'truncate') return false;
  return bytesEqual(split.content.subarray(0, split.declaredSize), packed);
}

/**
 * The pack-bitmap flavour of `LoadedBitmapArtefact` (`bitmap-binding.ts`):
 * loads, parses and range-validates a pack's own `.bitmap`, and builds the
 * two mapping functions the shared closure algorithm needs — both running
 * through the pack's `.idx`. A bit is a PACK position; an entry header's
 * `position` is an INDEX position — see `bitmap-binding.ts`'s module doc.
 *
 * Both mappings are SEARCHES over the `.idx`, never tables materialised over
 * it: the tier resolves a handful of tips and one oid per emitted object, so
 * an offset → index-position map plus a hex string per object would be a
 * repository-sized allocation to serve a repository-sized fraction of it.
 * The one table kept is the inverse `packPositions` gives, which every
 * marked tip reads.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import { lookupPackIndexPosition, objectIdAt } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
// Type-only: keeps the dependency-cruiser no-circular rule happy and
// structurally forbids this module from ever importing a runtime value out
// of the registry it is bound into.
import type { RegisteredPack } from '../pack-registry.js';
import type { LoadedPackBitmap } from './bitmap-binding.js';
import {
  buildEntryByOwnPosition,
  declineBitmap,
  invertPositions,
  usableBitmapBytes,
  validateBitmapContainer,
} from './bitmap-container.js';

/**
 * Loads, parses and range-validates a pack's bitmap, or returns `undefined`
 * for the caller to fall back to the next artefact in the preference order
 * — silently for absent/unreadable, with one `ctx.logger?.warn?.` for a
 * present-but-faulty artefact (refused, a structural parse refusal, an
 * out-of-range position, or a position table that is not a permutation):
 * the opposite of the silent cases, because git itself prints an error there.
 *
 * `pack.packPositions()` — the position-mapping memo whose result turns a
 * decoded pack position into an oid — is reached ONLY after
 * `validateBitmapRanges` has already accepted every position the artefact
 * decodes. Nothing above that call resolves an oid.
 */
export async function loadPackBitmapArtefact(
  ctx: Context,
  pack: RegisteredPack,
): Promise<LoadedPackBitmap | undefined> {
  if (!pack.hasBitmap) return undefined;
  const load = await pack.bitmapBytes();
  const artefactName = `${pack.name}.bitmap`;
  const bytes = usableBitmapBytes(ctx, 'pack', artefactName, load);
  if (bytes === undefined) return undefined;

  const index = await pack.index();
  const container = validateBitmapContainer(ctx, 'pack', artefactName, bytes, index.objectCount);
  if (container === undefined) return undefined;
  const { bitmap, headers, objectCount, laneCount, typeBits } = container;

  const packPositions = await pack.packPositions();
  const ownPositionToBitPosition = invertPositions(packPositions);
  if (ownPositionToBitPosition === undefined) {
    return declineBitmap(
      ctx,
      'pack position table is not a permutation, declining pack bitmap',
      artefactName,
    );
  }

  return {
    artefactName,
    bitmap,
    headers,
    objectCount,
    laneCount,
    typeBits,
    resolveOwnPosition: (oid) => lookupPackIndexPosition(index, oid),
    entryByOwnPosition: buildEntryByOwnPosition(headers),
    ownPositionToBitPosition,
    oidAtBitPosition: (bitPosition): ObjectId | undefined => {
      const indexPosition = packPositions[bitPosition];
      return indexPosition === undefined ? undefined : objectIdAt(index, indexPosition);
    },
  };
}

/**
 * The pack-bitmap flavour of `LoadedBitmapArtefact` (`bitmap-binding.ts`):
 * loads, parses and range-validates a pack's own `.bitmap`, and builds the
 * two mapping functions the shared closure algorithm needs — both running
 * through the pack's `.idx`. A bit is a PACK position; an entry header's
 * `position` is an INDEX position — see `bitmap-binding.ts`'s module doc.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import { entryOffsets, lookupPackIndex } from '../../../domain/storage/index.js';
// `allObjectIds` is not barrel-exported — imported directly, as
// `enumerate-objects.ts` already does.
import { allObjectIds } from '../../../domain/storage/pack-index.js';
import type { Context } from '../../../ports/context.js';
// Type-only: keeps the dependency-cruiser no-circular rule happy and
// structurally forbids this module from ever importing a runtime value out
// of the registry it is bound into.
import type { RegisteredPack } from '../pack-registry.js';
import {
  buildEntryByOwnPosition,
  invertPositions,
  type LoadedPackBitmap,
  usableBitmapBytes,
  validateBitmapContainer,
} from './bitmap-binding.js';

/**
 * Loads, parses and range-validates a pack's bitmap, or returns `undefined`
 * for the caller to fall back to the next artefact in the preference order
 * — silently for absent/unreadable, with one `ctx.logger?.warn?.` for a
 * present-but-faulty artefact (refused, a structural parse refusal, or an
 * out-of-range position): the opposite of the silent cases, because git
 * itself prints an error there.
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
  const offsetToIndexPosition = new Map(
    entryOffsets(index).map((offset, i) => [offset, i] as const),
  );
  const oidsByIndexPosition = allObjectIds(index);

  return {
    artefactName,
    bitmap,
    headers,
    objectCount,
    laneCount,
    typeBits,
    resolveOwnPosition: (oid) => {
      const offset = lookupPackIndex(index, oid);
      if (offset === undefined) return undefined;
      return offsetToIndexPosition.get(offset);
    },
    entryByOwnPosition: buildEntryByOwnPosition(headers),
    ownPositionToBitPosition: invertPositions(packPositions),
    oidAtBitPosition: (bitPosition) =>
      oidsByIndexPosition[packPositions[bitPosition] as number] as ObjectId,
  };
}

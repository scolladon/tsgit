/**
 * The midx-bitmap flavour of `LoadedBitmapArtefact` (`bitmap-binding.ts`):
 * loads, parses and range-validates the in-use multi-pack-index's own
 * `.bitmap`, and builds the two mapping functions the shared closure
 * algorithm needs — both running through the midx's OIDL and its
 * reverse-index chunk, with NO pack access at all.
 *
 * A bit is a PSEUDO-PACK position: `oid = midxOidAt(midx,
 * midxReverseIndexAt(midx, p))`. An entry header's own `position` is a MIDX
 * position, so `midxOidAt(midx, header.position)` names the commit
 * DIRECTLY — no reverse-index hop. Getting this backwards is the single
 * most likely implementation bug in this module.
 *
 * A midx with no reverse-index chunk carries no bitmap a tool that writes
 * one would have produced — not consumable, and declined silently, the
 * same as an absent artefact, never a fault.
 *
 * `core.multiPackIndex` is never consulted here, a named deliberate
 * divergence: with the key set to `false`, git reads the pack bitmap where
 * tsgit reads this one. Both compute the same object set, so the
 * divergence is in which file is opened, never in an answer.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  lookupMidxPosition,
  midxOidAt,
  midxReverseIndexPositions,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
// Type-only: keeps the dependency-cruiser no-circular rule happy and
// structurally forbids this module from ever importing a runtime value out
// of the registry it is bound into.
import type { MidxBitmapLoad } from '../pack-registry.js';
import {
  buildEntryByOwnPosition,
  declineBitmap,
  invertPositions,
  type LoadedBitmapArtefact,
  usableBitmapBytes,
  validateBitmapContainer,
} from './bitmap-binding.js';

export type LoadedMidxBitmap = LoadedBitmapArtefact;

/**
 * Loads, parses and range-validates the in-use midx's bitmap, or returns
 * `undefined` for the caller to fall back to the next artefact in the
 * preference order — silently for absent/unreadable/no-usable-midx/no-
 * reverse-index-chunk, with one `ctx.logger?.warn?.` for a present-but-
 * faulty artefact (refused, a structural parse refusal, or an out-of-range
 * position): the opposite of the silent cases, because git itself prints an
 * error there.
 *
 * `load` is the generation-level memo `PackRegistry.midxBitmap()` already
 * computes — this function PARSES what that memo only hashes. Every
 * position this module decodes — entry headers (midx positions) and every
 * set bit (pseudo-pack positions) — is checked against `load.midx.objectCount`,
 * the pseudo-pack's own count, by the SAME `validateBitmapRanges` a pack
 * bitmap uses (it is already agnostic to which position space it
 * validates). The reverse-index chunk's own STORED values are proved in the
 * same space straight after, before either mapping exists; `midxOidAt` is
 * reached only past both, and only as an emitted object's oid is needed.
 */
export async function loadMidxBitmapArtefact(
  ctx: Context,
  load: MidxBitmapLoad | undefined,
): Promise<LoadedMidxBitmap | undefined> {
  if (load === undefined) return undefined;
  // Free structural information: a midx written without a bitmap carries no
  // reverse-index chunk, so a bitmap found beside one is not consumable.
  // Checked before the bitmap bytes' own load outcome — this is a property
  // of the MIDX, not of the bitmap file.
  if (load.midx.reverseIndexOffset === undefined) return undefined;
  const bytes = usableBitmapBytes(ctx, 'midx', load.artefact, load);
  if (bytes === undefined) return undefined;

  const { midx } = load;
  const container = validateBitmapContainer(ctx, 'midx', load.artefact, bytes, midx.objectCount);
  if (container === undefined) return undefined;
  const { bitmap, headers, objectCount, laneCount, typeBits } = container;

  // Read AFTER the container's own validation, and validated in turn:
  // `midxReverseIndexAt` bounds-checks the position it is ASKED for, never
  // the position it returns, so a hostile chunk storing a value past the
  // OIDL's end would resolve a bit to no object at all — and hand the caller
  // an entry with no id. The whole artefact declines instead.
  const midxPositionOfBit = midxReverseIndexPositions(midx);
  if (midxPositionOfBit === undefined) {
    return declineBitmap(
      ctx,
      'midx reverse index position out of range, declining midx bitmap',
      load.artefact,
    );
  }
  const ownPositionToBitPosition = invertPositions(midxPositionOfBit);
  if (ownPositionToBitPosition === undefined) {
    return declineBitmap(
      ctx,
      'midx reverse index is not a permutation, declining midx bitmap',
      load.artefact,
    );
  }

  return {
    artefactName: load.artefact,
    bitmap,
    headers,
    objectCount,
    laneCount,
    typeBits,
    resolveOwnPosition: (oid) => lookupMidxPosition(midx, oid),
    entryByOwnPosition: buildEntryByOwnPosition(headers),
    ownPositionToBitPosition,
    oidAtBitPosition: (bitPosition): ObjectId | undefined => {
      const midxPosition = midxPositionOfBit[bitPosition];
      return midxPosition === undefined ? undefined : midxOidAt(midx, midxPosition);
    },
  };
}

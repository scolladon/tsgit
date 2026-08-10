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
import { midxOidAt, midxReverseIndexAt } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
// Type-only: keeps the dependency-cruiser no-circular rule happy and
// structurally forbids this module from ever importing a runtime value out
// of the registry it is bound into.
import type { MidxBitmapLoad } from '../pack-registry.js';
import {
  buildEntryByOwnPosition,
  invertPositions,
  type LoadedBitmapArtefact,
  parseBitmapContainer,
} from './bitmap-binding.js';
import { laneCountFor, validateBitmapRanges } from './bitmap-range-validation.js';
import { faultContext } from './pack-shared.js';

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
 * validates). `midxOidAt`/`midxReverseIndexAt` are reached ONLY after that
 * validation has already accepted every position the artefact decodes.
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
  if (load.kind === 'absent' || load.kind === 'unreadable') return undefined;
  if (load.kind === 'refused') {
    ctx.logger?.warn?.('bitmapBinding: discarding unusable midx bitmap', {
      bitmap: load.artefact,
      ...faultContext(load.data),
    });
    return undefined;
  }

  const { midx } = load;
  const parsed = parseBitmapContainer(ctx, load.bytes, load.artefact, 'midx');
  if (parsed === undefined) return undefined;
  const { bitmap, headers } = parsed;

  const objectCount = midx.objectCount;
  const validated = validateBitmapRanges(bitmap, headers, objectCount);
  if (validated === undefined) {
    ctx.logger?.warn?.('bitmapBinding: midx bitmap position out of range, declining', {
      bitmap: load.artefact,
    });
    return undefined;
  }

  // Both built AFTER validation, per the doc comment above: every midx
  // position `midxOidAt` reads here is one of `[0, objectCount)` by
  // construction (the loop bound), never a decoded, unvalidated position.
  const oidByMidxPosition = Array.from({ length: objectCount }, (_unused, i) => midxOidAt(midx, i));
  const oidToMidxPosition = new Map(oidByMidxPosition.map((oid, i) => [oid, i] as const));
  const pseudoPackPositionOfMidxPosition = Array.from({ length: objectCount }, (_unused, p) =>
    midxReverseIndexAt(midx, p),
  );

  return {
    artefactName: load.artefact,
    bitmap,
    headers,
    objectCount,
    laneCount: laneCountFor(objectCount),
    typeBits: validated.typeBits,
    resolveOwnPosition: (oid) => oidToMidxPosition.get(oid),
    entryByOwnPosition: buildEntryByOwnPosition(headers),
    ownPositionToBitPosition: invertPositions(pseudoPackPositionOfMidxPosition),
    oidAtBitPosition: (bitPosition) =>
      oidByMidxPosition[pseudoPackPositionOfMidxPosition[bitPosition] as number] as ObjectId,
  };
}

/**
 * The pack-position ↔ index-position mapping a pack's own `.idx` implies —
 * the reference computation a `.rev` file's body is checked against.
 */
import {
  entryOffsets,
  type PackIndex,
  type PackRevIndex,
  revIndexPositionAt,
} from '../../../domain/storage/index.js';

/**
 * Index positions `[0, N)`, reordered by ascending `entryOffsets(index)[i]`
 * — position `q` of the result is the index position of the object at pack
 * position `q` (the object at rank `q` by pack offset), exactly what a `.rev`
 * file's body entry `q` is supposed to store.
 */
export function packPositionMap(index: PackIndex): Uint32Array {
  const offsets = entryOffsets(index);
  const positions = new Uint32Array(offsets.length);
  for (let indexPosition = 0; indexPosition < positions.length; indexPosition += 1) {
    positions[indexPosition] = indexPosition;
  }
  positions.sort((a, b) => offsets[a]! - offsets[b]!);
  return positions;
}

/**
 * The same table read straight out of a TRUSTED `.rev` body — one
 * `Uint32Array` filled in place, never an identity array gathered through
 * itself. `undefined` on the first stored value that does not name an index
 * position of this pack, the caller's signal to fall back to
 * `packPositionMap`; the body's values are otherwise trusted exactly as
 * canonical git trusts them, with no digest check on the read path.
 */
export function revIndexPositions(rev: PackRevIndex, objectCount: number): Uint32Array | undefined {
  const positions = new Uint32Array(objectCount);
  for (let packPosition = 0; packPosition < objectCount; packPosition += 1) {
    const indexPosition = revIndexPositionAt(rev, packPosition);
    if (indexPosition >= objectCount) return undefined;
    positions[packPosition] = indexPosition;
  }
  return positions;
}

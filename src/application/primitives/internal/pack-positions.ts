/**
 * The pack-position ↔ index-position mapping a pack's own `.idx` implies —
 * the reference computation a `.rev` file's body is checked against.
 */
import { entryOffsets, type PackIndex } from '../../../domain/storage/index.js';

/**
 * Index positions `[0, N)`, reordered by ascending `entryOffsets(index)[i]`
 * — position `q` of the result is the index position of the object at pack
 * position `q` (the object at rank `q` by pack offset), exactly what a `.rev`
 * file's body entry `q` is supposed to store.
 */
export function packPositionMap(index: PackIndex): ReadonlyArray<number> {
  const offsets = entryOffsets(index);
  const positions = offsets.map((_offset, indexPosition) => indexPosition);
  positions.sort((a, b) => offsets[a]! - offsets[b]!);
  return positions;
}

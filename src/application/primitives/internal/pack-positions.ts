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
export function packPositionMap(index: PackIndex): ReadonlyArray<number> {
  const offsets = entryOffsets(index);
  const positions = offsets.map((_offset, indexPosition) => indexPosition);
  positions.sort((a, b) => offsets[a]! - offsets[b]!);
  return positions;
}

/**
 * O(n) gather of a pack's offset table from a TRUSTED `.rev` body —
 * `raw[revIndexPositionAt(rev, p)]` for each pack position `p`, in order.
 * The body's stored VALUES are never verified here (the artefact's digest is
 * checked by `fsck` and nowhere else on the read path); only that each one
 * lands inside `raw`'s bounds, since an out-of-range position would
 * otherwise read `undefined` off the end of the array. Returns `undefined`
 * on the first such violation — the caller's signal to fall back to sorting
 * `raw` itself for this pack.
 */
export function gatherByRevIndex(
  rev: PackRevIndex,
  raw: ReadonlyArray<number>,
): ReadonlyArray<number> | undefined {
  const n = raw.length;
  const gathered = new Array<number>(n);
  for (let p = 0; p < n; p += 1) {
    const indexPosition = revIndexPositionAt(rev, p);
    if (indexPosition >= n) return undefined;
    gathered[p] = raw[indexPosition] as number;
  }
  return gathered;
}

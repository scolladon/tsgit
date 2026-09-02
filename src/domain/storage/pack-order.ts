import { compareBytes } from '../objects/encoding.js';

/**
 * One pack's index inputs in EMISSION order (ascending pack offset) — flat
 * typed-array slabs rather than one allocation per object, so indexing a
 * multi-million-object pack does not materialise a matching array of
 * per-entry wrapper objects. `count` is the only bound: every array MAY be
 * longer than `count` (an over-allocated producer's own capacity), so a
 * consumer reads `count`, never `.length`.
 */
export interface PackIndexEntries {
  readonly count: number;
  readonly digestLength: number; // 20 | 32
  readonly oids: Uint8Array; // >= count * digestLength
  readonly crcValues: Int32Array; // >= count
  readonly offsets: Float64Array; // >= count
}

/**
 * An entry set paired with its own oid-ascending permutation: index position
 * `p` holds entry ordinal `order[p]`.
 */
export interface SortedPackIndex {
  readonly entries: PackIndexEntries;
  readonly order: Uint32Array; // length === entries.count
}

/**
 * The single ordering step `serializePackIndex` and `serializePackRevIndex`
 * both build on, so the two artefacts cannot disagree about the entry set's
 * oid order. Builds a `Uint32Array` permutation of `[0, count)`, sorted
 * oid-ascending by `compareBytes`-ing ranges of the `oids` slab directly —
 * never `subarray`d once into a retained per-entry array, which would
 * reintroduce the very allocation this shape exists to delete.
 */
export function sortPackIndexEntries(entries: PackIndexEntries): SortedPackIndex {
  const { count, digestLength, oids } = entries;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    order[i] = i;
  }
  order.sort((a, b) =>
    compareBytes(
      oids.subarray(a * digestLength, (a + 1) * digestLength),
      oids.subarray(b * digestLength, (b + 1) * digestLength),
    ),
  );
  return { entries, order };
}

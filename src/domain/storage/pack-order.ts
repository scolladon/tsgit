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
  readonly digestLength: number; // 20 | 32, enforced at every serializer
  readonly oids: Uint8Array; // >= count * digestLength
  readonly crcValues: Uint32Array; // >= count — crc32 is unsigned
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
 * oid order. Builds a `Uint32Array` permutation of `[0, count)` and sorts it
 * with a comparator that indexes the `oids` slab in place. The comparator
 * allocates nothing: a `subarray` per comparison would be O(N log N)
 * allocations, worse than the per-entry array this shape exists to delete.
 */
export function sortPackIndexEntries(entries: PackIndexEntries): SortedPackIndex {
  const { count, digestLength, oids } = entries;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    order[i] = i;
  }
  order.sort((a, b) => {
    const aStart = a * digestLength;
    const bStart = b * digestLength;
    for (let i = 0; i < digestLength; i += 1) {
      const delta = oids[aStart + i]! - oids[bStart + i]!;
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return { entries, order };
}

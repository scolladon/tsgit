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

/** Which invariant a `SortedPackIndex` broke — mapped by each serializer onto
 *  its own refusal discriminant, so a structural length failure is never
 *  reported as a hash-width one. */
export type SortedPackIndexDefect = 'hash-id' | 'size' | 'count';

/**
 * The one structural gate every pack-index artefact shares. `SortedPackIndex`
 * is published, so a caller can hand over any shape it likes and the checks
 * cannot live in the type; they lived in three places instead, character for
 * character apart from the thrower, where `jscpd` could not see them — the
 * interleaved error calls break every window below its threshold.
 *
 * Each serializer passes its own `fail`, which must not return.
 */
export function assertValidSortedPackIndex(
  sorted: SortedPackIndex,
  digestLength: number,
  fail: (defect: SortedPackIndexDefect, reason: string) => never,
): void {
  if (digestLength !== 20 && digestLength !== 32) {
    fail('hash-id', `packChecksum must be 20 or 32 bytes, got ${digestLength}`);
  }
  const { entries, order } = sorted;
  const { count, oids, crcValues, offsets } = entries;
  if (entries.digestLength !== digestLength) {
    fail(
      'hash-id',
      `entries digestLength ${entries.digestLength} does not match packChecksum length ${digestLength}`,
    );
  }
  if (oids.length < count * digestLength) {
    fail('size', `oids too short: need ${count * digestLength}, got ${oids.length}`);
  }
  if (crcValues.length < count) {
    fail('size', `crcValues too short: need ${count}, got ${crcValues.length}`);
  }
  if (offsets.length < count) {
    fail('size', `offsets too short: need ${count}, got ${offsets.length}`);
  }
  if (order.length !== count) {
    fail('count', `order length ${order.length} does not match entries count ${count}`);
  }
}

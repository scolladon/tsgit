/**
 * A pure, I/O-free typed-array store for one pack's resolved entries, plus
 * two sorted child indexes over the OFS/REF delta side tables pass 2 walks
 * the delta forest through. Splitting this out of the indexer keeps that
 * module under the repo's line ceiling and gives the one genuinely
 * algorithmic piece of this change the property-test lens the I/O-bound
 * passes cannot take.
 *
 * Capacity grows geometrically from a small initial size as entries are
 * actually appended: `header.objectCount` is a server-controlled `uint32`
 * on attacker-supplied bytes and is never an allocation input.
 * `structuralMaxEntries` — the caller's own bound, independent of the
 * declared count — clamps every growth step underneath the doubling, so a
 * lying header claiming millions of entries over a tiny pack still
 * allocates for the real entry count.
 */
import { compareBytes } from '../../../domain/objects/encoding.js';
import { invalidPackEntry } from '../../../domain/storage/error.js';
import { PACK_HEADER_SIZE, type PackEntryType } from '../../../domain/storage/pack-entry.js';
import type { PackIndexEntries } from '../../../domain/storage/pack-order.js';

const INITIAL_CAPACITY = 4;
const GROWTH_FACTOR = 2;

/** Bit layout of one `types` byte: the low 3 bits carry the `PackEntryType`
 *  (values 1–7 all fit), the next bit is the `resolved` flag. An all-zero
 *  oid slot is a legal, if absurd, hash — never a usable "unresolved"
 *  sentinel — so resolution state lives in this flag, not in the oid. */
const TYPE_MASK = 0b0111;
const RESOLVED_FLAG = 0b1000;

/** The next capacity for a store growing from `current` to hold at least
 *  `needed` entries: geometric doubling from `current` (or `INITIAL_CAPACITY`
 *  when there is no current capacity yet), clamped underneath by
 *  `structuralMax` — but never below `needed` itself, since correctness
 *  (storing every real entry) always wins over the clamp. */
function growCapacityTo(current: number, needed: number, structuralMax: number): number {
  let candidate = current > 0 ? current : INITIAL_CAPACITY;
  while (candidate < needed) candidate *= GROWTH_FACTOR;
  return Math.max(needed, Math.min(candidate, structuralMax));
}

export interface PackRecordStore {
  readonly count: number;
  readonly resolvedCount: number;
  /** Number of REF deltas recorded — `D_ref`, the raw (append-order) table
   *  `refDeltaOrdinalAt`/`refDeltaBaseOidAt` read, distinct from the
   *  oid-sorted `refSortedRefIndices` `refChildren`/`refChildOrdinalAt`
   *  read. Lets a caller sweep every REF delta once, in the order pass 1
   *  recorded it, without needing a base oid to look one up by. */
  readonly refDeltaCount: number;
  append(offset: number, crcValue: number, type: PackEntryType): number;
  setOid(ordinal: number, bytes: Uint8Array): void;
  markResolved(ordinal: number): void;
  isResolved(ordinal: number): boolean;
  typeOf(ordinal: number): PackEntryType;
  offsetOf(ordinal: number): number;
  oidRangeOf(ordinal: number): { readonly start: number; readonly end: number };
  recordOfsDelta(ordinal: number, baseOffset: number): void;
  recordRefDelta(ordinal: number, baseOidBytes: Uint8Array): void;
  buildChildIndexes(): void;
  ofsChildren(baseOffset: number): { readonly start: number; readonly end: number };
  ofsChildOrdinalAt(position: number): number;
  refChildren(baseOidBytes: Uint8Array): { readonly start: number; readonly end: number };
  refChildOrdinalAt(position: number): number;
  /** The entry ordinal of the `position`-th REF delta recorded, in
   *  append (pack-offset) order — `position` ranges `[0, refDeltaCount)`. */
  refDeltaOrdinalAt(position: number): number;
  /** The declared base oid bytes of the `position`-th REF delta recorded,
   *  in the same append order as `refDeltaOrdinalAt`. */
  refDeltaBaseOidAt(position: number): Uint8Array;
  view(): PackIndexEntries;
}

export function createPackRecordStore(
  digestLength: 20 | 32,
  structuralMaxEntries: number,
): PackRecordStore {
  const structuralMax = Math.max(structuralMaxEntries, 0);

  let capacity = Math.min(INITIAL_CAPACITY, structuralMax);
  let offsets = new Float64Array(capacity);
  let crcValues = new Uint32Array(capacity);
  let types = new Uint8Array(capacity);
  let oids = new Uint8Array(capacity * digestLength);
  let count = 0;
  let resolvedCount = 0;

  // Delta side tables (application-owned, never crossing into a domain
  // signature). `deltaEntry`/`deltaBaseOffset` hold the OFS deltas, keyed by
  // the base offset they name. A REF delta has no base offset, so it lives
  // only in `refEntry`/`refBaseOids` — keeping the two apart means a REF-free
  // pack never allocates oid bytes, and a REF-heavy one never allocates
  // offset slots that no lookup would ever read.
  let deltaCapacity = Math.min(INITIAL_CAPACITY, structuralMax);
  let deltaEntry = new Int32Array(deltaCapacity);
  let deltaBaseOffset = new Float64Array(deltaCapacity);
  let deltaCount = 0;

  let refCapacity = Math.min(INITIAL_CAPACITY, structuralMax);
  let refBaseOids = new Uint8Array(refCapacity * digestLength);
  let refEntry = new Int32Array(refCapacity);
  let refCount = 0;

  let ofsSortedDeltaIndices = new Int32Array(0);
  let refSortedRefIndices = new Int32Array(0);

  const ensureEntryCapacity = (needed: number): void => {
    if (needed <= capacity) return;
    const nextCapacity = growCapacityTo(capacity, needed, structuralMax);
    const nextOffsets = new Float64Array(nextCapacity);
    nextOffsets.set(offsets);
    const nextCrcValues = new Uint32Array(nextCapacity);
    nextCrcValues.set(crcValues);
    const nextTypes = new Uint8Array(nextCapacity);
    nextTypes.set(types);
    const nextOids = new Uint8Array(nextCapacity * digestLength);
    nextOids.set(oids);
    offsets = nextOffsets;
    crcValues = nextCrcValues;
    types = nextTypes;
    oids = nextOids;
    capacity = nextCapacity;
  };

  const ensureDeltaCapacity = (needed: number): void => {
    if (needed <= deltaCapacity) return;
    const nextCapacity = growCapacityTo(deltaCapacity, needed, structuralMax);
    const nextDeltaEntry = new Int32Array(nextCapacity);
    nextDeltaEntry.set(deltaEntry);
    const nextDeltaBaseOffset = new Float64Array(nextCapacity);
    nextDeltaBaseOffset.set(deltaBaseOffset);
    deltaEntry = nextDeltaEntry;
    deltaBaseOffset = nextDeltaBaseOffset;
    deltaCapacity = nextCapacity;
  };

  const ensureRefCapacity = (needed: number): void => {
    if (needed <= refCapacity) return;
    const nextCapacity = growCapacityTo(refCapacity, needed, structuralMax);
    const nextRefBaseOids = new Uint8Array(nextCapacity * digestLength);
    nextRefBaseOids.set(refBaseOids);
    const nextRefEntry = new Int32Array(nextCapacity);
    nextRefEntry.set(refEntry);
    refBaseOids = nextRefBaseOids;
    refEntry = nextRefEntry;
    refCapacity = nextCapacity;
  };

  const append = (offset: number, crcValue: number, type: PackEntryType): number => {
    ensureEntryCapacity(count + 1);
    const ordinal = count;
    offsets[ordinal] = offset;
    crcValues[ordinal] = crcValue;
    types[ordinal] = type & TYPE_MASK;
    count += 1;
    return ordinal;
  };

  const setOid = (ordinal: number, bytes: Uint8Array): void => {
    oids.set(bytes, ordinal * digestLength);
  };

  const markResolved = (ordinal: number): void => {
    types[ordinal] = types[ordinal]! | RESOLVED_FLAG;
    resolvedCount += 1;
  };

  const isResolved = (ordinal: number): boolean => (types[ordinal]! & RESOLVED_FLAG) !== 0;

  const typeOf = (ordinal: number): PackEntryType => (types[ordinal]! & TYPE_MASK) as PackEntryType;

  const offsetOf = (ordinal: number): number => offsets[ordinal]!;

  const oidRangeOf = (ordinal: number): { readonly start: number; readonly end: number } => ({
    start: ordinal * digestLength,
    end: (ordinal + 1) * digestLength,
  });

  const recordOfsDelta = (ordinal: number, baseOffset: number): void => {
    const entryOffset = offsetOf(ordinal);
    if (baseOffset < PACK_HEADER_SIZE || baseOffset >= entryOffset) {
      throw invalidPackEntry(entryOffset, 'delta base offset is out of bound');
    }
    ensureDeltaCapacity(deltaCount + 1);
    deltaEntry[deltaCount] = ordinal;
    deltaBaseOffset[deltaCount] = baseOffset;
    deltaCount += 1;
  };

  const recordRefDelta = (ordinal: number, baseOidBytes: Uint8Array): void => {
    ensureRefCapacity(refCount + 1);
    refBaseOids.set(baseOidBytes, refCount * digestLength);
    refEntry[refCount] = ordinal;
    refCount += 1;
  };

  const buildChildIndexes = (): void => {
    const ofsSorted = new Int32Array(deltaCount);
    for (let d = 0; d < deltaCount; d += 1) ofsSorted[d] = d;
    ofsSorted.sort((a, b) => deltaBaseOffset[a]! - deltaBaseOffset[b]!);
    ofsSortedDeltaIndices = ofsSorted;

    const refSorted = new Int32Array(refCount);
    for (let r = 0; r < refCount; r += 1) refSorted[r] = r;
    const refOidSlice = (r: number): Uint8Array =>
      refBaseOids.subarray(r * digestLength, (r + 1) * digestLength);
    refSorted.sort((a, b) => compareBytes(refOidSlice(a), refOidSlice(b)));
    refSortedRefIndices = refSorted;
  };

  const ofsChildren = (baseOffset: number): { readonly start: number; readonly end: number } => {
    let lo = 0;
    let hi = ofsSortedDeltaIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midOffset = deltaBaseOffset[ofsSortedDeltaIndices[mid]!]!;
      if (midOffset < baseOffset) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (
      end < ofsSortedDeltaIndices.length &&
      deltaBaseOffset[ofsSortedDeltaIndices[end]!]! === baseOffset
    ) {
      end += 1;
    }
    return { start: lo, end };
  };

  const ofsChildOrdinalAt = (position: number): number =>
    deltaEntry[ofsSortedDeltaIndices[position]!]!;

  const refChildren = (
    baseOidBytes: Uint8Array,
  ): { readonly start: number; readonly end: number } => {
    const oidAt = (position: number): Uint8Array => {
      const r = refSortedRefIndices[position]!;
      return refBaseOids.subarray(r * digestLength, (r + 1) * digestLength);
    };
    let lo = 0;
    let hi = refSortedRefIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(oidAt(mid), baseOidBytes) < 0) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < refSortedRefIndices.length && compareBytes(oidAt(end), baseOidBytes) === 0) {
      end += 1;
    }
    return { start: lo, end };
  };

  const refChildOrdinalAt = (position: number): number => refEntry[refSortedRefIndices[position]!]!;

  const refDeltaOrdinalAt = (position: number): number => refEntry[position]!;

  const refDeltaBaseOidAt = (position: number): Uint8Array =>
    refBaseOids.subarray(position * digestLength, (position + 1) * digestLength);

  const view = (): PackIndexEntries => ({ count, digestLength, oids, crcValues, offsets });

  return {
    get count() {
      return count;
    },
    get resolvedCount() {
      return resolvedCount;
    },
    get refDeltaCount() {
      return refCount;
    },
    append,
    setOid,
    markResolved,
    isResolved,
    typeOf,
    offsetOf,
    oidRangeOf,
    recordOfsDelta,
    recordRefDelta,
    buildChildIndexes,
    ofsChildren,
    ofsChildOrdinalAt,
    refChildren,
    refChildOrdinalAt,
    refDeltaOrdinalAt,
    refDeltaBaseOidAt,
    view,
  };
}

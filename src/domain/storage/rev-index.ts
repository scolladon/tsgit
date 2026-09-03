/**
 * Pack reverse index (`.rev`) parser and serializer. `parsePackRevIndex`
 * decodes git's `pack-<sha>.rev` format; `serializePackRevIndex` emits it —
 * the body maps each pack position (rank by ascending offset) to the index
 * position (rank by ascending oid) the `.idx` and `.pack` agree on.
 *
 * @writes
 *   surface: packRevIndex
 *   kind:    byte-identical
 *   format:  pack-rev-index-v1
 */
import { invalidPackRevIndex } from './error.js';
import { assertValidSortedPackIndex, type SortedPackIndex } from './pack-order.js';

const REV_MAGIC = 0x52494458; // 'RIDX'

export const REV_HEADER_SIZE = 12;
export const REASON_REV_INDEX_TOO_SMALL = 'reverse index is too small' as const;
export const REASON_REV_INDEX_CORRUPT = 'reverse index is corrupt' as const;

export interface PackRevIndex {
  readonly version: 1;
  readonly hashId: 1 | 2;
  readonly digestLength: number;
  readonly objectCount: number;
  /**
   * The embedded copy of the pack checksum. Retained but never compared:
   * canonical git does not verify this field either, so checking it here
   * would refuse files git reads.
   */
  readonly packChecksum: Uint8Array;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

/**
 * Parses a pack reverse-index file's bytes into its structural fields. Every
 * `DataView` read is proved in-bounds by an earlier gate — a `RangeError`
 * escaping this function is a defect, never an expected error path.
 *
 * `objectCount` comes from the pack's own `.idx` — the file carries no count,
 * only a length that implies one, so deriving it would make the size check
 * tautological and an appended-bytes corruption undetectable.
 */
export function parsePackRevIndex(
  bytes: Uint8Array,
  digestLength: number,
  objectCount: number,
): PackRevIndex {
  if (bytes.length < REV_HEADER_SIZE + 2 * digestLength) {
    throw invalidPackRevIndex('size', REASON_REV_INDEX_TOO_SMALL);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const signature = view.getUint32(0);
  if (signature !== REV_MAGIC) {
    throw invalidPackRevIndex(
      'signature',
      `invalid signature: expected 0x${REV_MAGIC.toString(16)}, got 0x${signature.toString(16).padStart(8, '0')}`,
    );
  }

  const version = view.getUint32(4);
  if (version !== 1) {
    throw invalidPackRevIndex('version', `unsupported version: expected 1, got ${version}`);
  }

  const hashId = view.getUint32(8);
  if (hashId !== 1 && hashId !== 2) {
    throw invalidPackRevIndex('hash-id', `unsupported hash id: expected 1 or 2, got ${hashId}`);
  }

  // No comparison against `digestLength` here — canonical git accepts a
  // `hashId` that disagrees with the repository's own hash width.
  // Recorded as a field, never a gate; the opposite of the midx's
  // `hash-version` rule (`midx.ts`), and the difference is measured, not
  // stylistic.

  if (bytes.length !== REV_HEADER_SIZE + 4 * objectCount + 2 * digestLength) {
    throw invalidPackRevIndex('size', REASON_REV_INDEX_CORRUPT);
  }

  const checksumStart = REV_HEADER_SIZE + 4 * objectCount;
  const packChecksum = bytes.subarray(checksumStart, checksumStart + digestLength);

  return {
    version,
    hashId,
    digestLength,
    objectCount,
    packChecksum,
    _bytes: bytes,
    _view: view,
  };
}

/**
 * Structural shape guards for a `.rev` write's `SortedPackIndex` input,
 * factored out purely to keep `serializePackRevIndex`'s own cognitive
 * complexity under the repo's ceiling — every branch here is still its own
 * coverage-gated test.
 */
const assertValidPackIndexInput = (sorted: SortedPackIndex, digestLength: number): void => {
  // `RevIndexCheck` has no `'count'` member; an order/count disagreement is a
  // structural size failure from this artefact's point of view.
  assertValidSortedPackIndex(sorted, digestLength, (defect, reason) => {
    throw invalidPackRevIndex(defect === 'count' ? 'size' : defect, reason);
  });
};

/**
 * Serializes a pack reverse index from a pre-sorted oid slab and a verified
 * pack checksum — the same `PackIndexEntries` slab `serializePackIndex`
 * consumes, so the two artefacts cannot disagree about the entry set.
 *
 * `packChecksum`'s width picks `hashId` (SHA-1 ⇒ 1, SHA-256 ⇒ 2). An
 * unrecognised width is refused with the same `'hash-id'` check the parser
 * raises, though every production call site passes a verified pack trailer,
 * so this guard is unreachable outside tests.
 *
 * The trailer's `digestLength` bytes are left zero — this function does not
 * hash; the caller fills them in place over the returned buffer.
 */
export function serializePackRevIndex(
  sorted: SortedPackIndex,
  packChecksum: Uint8Array,
): Uint8Array {
  const digestLength = packChecksum.length;
  assertValidPackIndexInput(sorted, digestLength);

  const { count } = sorted.entries;
  const hashId = digestLength === 32 ? 2 : 1;
  const objectCount = count;
  const body = packPositionsByOffset(sorted);

  const bytes = new Uint8Array(REV_HEADER_SIZE + 4 * objectCount + 2 * digestLength);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, REV_MAGIC);
  view.setUint32(4, 1);
  view.setUint32(8, hashId);
  body.forEach((indexPosition, packPosition) => {
    view.setUint32(REV_HEADER_SIZE + packPosition * 4, indexPosition);
  });
  bytes.set(packChecksum, REV_HEADER_SIZE + 4 * objectCount);

  return bytes;
}

/**
 * Index positions `[0, N)` (rank by ascending oid, via `sortPackIndexEntries`)
 * reordered by ascending pack offset — result entry `p` is the index
 * position of the object at pack position `p`. Offsets are unique by
 * construction (each pack entry begins where the previous one ends), so tie
 * behaviour is undefined because ties cannot occur.
 */
function packPositionsByOffset(sorted: SortedPackIndex): Uint32Array {
  const { entries, order } = sorted;
  const count = entries.count;
  const positions = new Uint32Array(count);
  // Offsets flattened into a typed array so the sort comparator does one
  // array load instead of two (`entries.offsets[order[i]]`) per comparison
  // (measured 2x on 500k-entry packs). Float64 covers the full safe-integer
  // offset range where Uint32 would truncate >4 GiB packs.
  const offsetsByPosition = new Float64Array(count);
  for (let indexPosition = 0; indexPosition < count; indexPosition += 1) {
    positions[indexPosition] = indexPosition;
    offsetsByPosition[indexPosition] = entries.offsets[order[indexPosition]!]!;
  }
  positions.sort((a, b) => offsetsByPosition[a]! - offsetsByPosition[b]!);
  return positions;
}

/**
 * Index position of the object at pack position `p`. `p` is bounds-checked;
 * the stored VALUE is not — an out-of-range value is a verification verdict
 * for the integrity pass, not a parse refusal, because canonical git compares
 * it like any other value.
 */
export function revIndexPositionAt(rev: PackRevIndex, p: number): number {
  if (p >= rev.objectCount) {
    throw invalidPackRevIndex(
      'size',
      `pack position ${p} out of range for ${rev.objectCount} objects`,
    );
  }
  return rev._view.getUint32(REV_HEADER_SIZE + p * 4);
}

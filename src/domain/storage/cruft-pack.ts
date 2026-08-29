/**
 * Cruft-pack `.mtimes` sidecar parser and serializer. A FLAT file — no
 * chunk table, unlike commit-graph, midx or the bitmap index: a fixed
 * 12-byte header, a dense per-object mtime table in `.idx` (oid-ascending)
 * order, the pack's own checksum, then a self-checksum over everything
 * before it, including the pack-checksum field.
 *
 * Structural twin of `rev-index.ts`, with one hard difference: `.rev`'s body
 * is PACK-OFFSET order (a permutation of the oid-ascending rank); this
 * body is oid-ascending order itself — the SAME index space
 * `serializePackIndex` encodes, never permuted.
 *
 * @writes
 *   surface: cruftMtimes
 *   kind:    byte-identical
 *   format:  cruft-mtimes-v1
 */
import { bytesEqual } from '../objects/encoding.js';
import type { ObjectId } from '../objects/object-id.js';
import { invalidCruftMtimes } from './error.js';
import { type SortedEntry, sortPackIndexEntries } from './pack-order.js';
import type { PackIndexWriterEntry } from './pack-writer.js';

export const CRUFT_MTIMES_MAGIC = 0x4d544d45; // 'MTME' — the final byte is 0x45/'E', not 0x53/'S'
const CRUFT_HEADER_SIZE = 12;

/**
 * Serializes a cruft pack's `.mtimes` sidecar from writer entries, the
 * verified pack checksum and an mtime lookup — the same
 * `PackIndexWriterEntry` set `serializePackIndex` consumes for the sibling
 * `.idx`, so the two artefacts cannot disagree about the entry set.
 *
 * The body is written directly at `.idx` position (oid-ascending) — there
 * is no permutation step here, unlike `serializePackRevIndex`'s pack-offset
 * reordering: index position IS body position.
 *
 * The trailer's digestLength bytes are left zero — this function does not
 * hash; the caller fills them in place over the returned buffer, mirroring
 * `buildRev`.
 */
export function serializeCruftMtimes(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
  mtimeOf: (oid: ObjectId) => number,
  presorted?: ReadonlyArray<SortedEntry>,
): Uint8Array {
  const digestLength = packChecksum.length;
  if (digestLength !== 20 && digestLength !== 32) {
    throw invalidCruftMtimes('hash-id', `packChecksum must be 20 or 32 bytes, got ${digestLength}`);
  }

  const hashId = digestLength === 32 ? 2 : 1;
  const objectCount = entries.length;
  // `.idx` position order — oid-ascending. This IS the body index; nothing
  // here is reordered by pack offset the way `.rev`'s body is.
  const mtimesByIndexPosition = presorted ?? sortPackIndexEntries(entries);

  const bytes = new Uint8Array(CRUFT_HEADER_SIZE + 4 * objectCount + 2 * digestLength);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, CRUFT_MTIMES_MAGIC);
  view.setUint32(4, 1);
  view.setUint32(8, hashId);
  mtimesByIndexPosition.forEach((sorted, indexPosition) => {
    view.setUint32(CRUFT_HEADER_SIZE + indexPosition * 4, mtimeOf(sorted.entry.id as ObjectId));
  });
  bytes.set(packChecksum, CRUFT_HEADER_SIZE + 4 * objectCount);

  return bytes;
}

/**
 * Parses a cruft pack's `.mtimes` sidecar into an oid → mtime map. Mtimes
 * come out keyed by `oidsInIndexOrder` — the sibling `.idx`'s own oid list,
 * taken as ground truth rather than re-derived, so a reader can never
 * invent its own index order.
 *
 * `selfChecksum`, when supplied, is the caller-computed
 * `hash(bytes[0, trailerStart))` — this module has zero platform
 * dependencies, so hashing is never done here — and is compared against the
 * trailing checksum field. Omitted, the field is read but not verified,
 * matching `parsePackRevIndex`'s posture toward its own embedded checksum.
 */
export function parseCruftMtimes(
  bytes: Uint8Array,
  oidsInIndexOrder: ReadonlyArray<ObjectId>,
  selfChecksum?: Uint8Array,
): ReadonlyMap<ObjectId, number> {
  if (bytes.length < CRUFT_HEADER_SIZE) {
    throw invalidCruftMtimes('size', 'cruft mtimes file is too small');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const signature = view.getUint32(0);
  if (signature !== CRUFT_MTIMES_MAGIC) {
    throw invalidCruftMtimes(
      'signature',
      `invalid signature: expected 0x${CRUFT_MTIMES_MAGIC.toString(16)}, got 0x${signature.toString(16).padStart(8, '0')}`,
    );
  }

  const version = view.getUint32(4);
  if (version !== 1) {
    throw invalidCruftMtimes('version', `unsupported version: expected 1, got ${version}`);
  }

  const hashId = view.getUint32(8);
  if (hashId !== 1 && hashId !== 2) {
    throw invalidCruftMtimes('hash-id', `unsupported hash id: expected 1 or 2, got ${hashId}`);
  }

  const digestLength = hashId === 2 ? 32 : 20;
  const objectCount = oidsInIndexOrder.length;
  const expectedLength = CRUFT_HEADER_SIZE + 4 * objectCount + 2 * digestLength;
  if (bytes.length !== expectedLength) {
    throw invalidCruftMtimes(
      'count',
      `object count disagrees with the .idx: expected ${objectCount} entries, got a ${bytes.length}-byte file`,
    );
  }

  assertSelfChecksum(bytes, digestLength, objectCount, selfChecksum);

  const mtimes = new Map<ObjectId, number>();
  for (let indexPosition = 0; indexPosition < objectCount; indexPosition += 1) {
    const mtime = view.getUint32(CRUFT_HEADER_SIZE + indexPosition * 4);
    mtimes.set(oidsInIndexOrder[indexPosition] as ObjectId, mtime);
  }
  return mtimes;
}

const assertSelfChecksum = (
  bytes: Uint8Array,
  digestLength: number,
  objectCount: number,
  selfChecksum: Uint8Array | undefined,
): void => {
  if (selfChecksum === undefined) return;
  const trailerStart = CRUFT_HEADER_SIZE + 4 * objectCount + digestLength;
  const stored = bytes.subarray(trailerStart, trailerStart + digestLength);
  if (!bytesEqual(stored, selfChecksum)) {
    throw invalidCruftMtimes('checksum', 'self-checksum mismatch');
  }
};

/**
 * Reftable stack-file codec: file header, file footer, the ofs-delta-style
 * varint, and non-log block framing (type byte, `uint24` block length,
 * `uint16` restart count). Pure, zero-copy, no I/O, no `Context` — the ref /
 * index / obj block record grammar, the restart-offset binary search, and
 * the writer's own emission build on top of this module in later parts.
 *
 * Version and hash are coupled by git's own writer (v1 is always SHA-1; v2
 * may carry either) but never assumed here — `digestLength` is derived from
 * the read `hashId`, never hardcoded.
 */
import { decode } from '../../objects/encoding.js';
import { crc32 } from '../../storage/crc32.js';
import { invalidReftable } from '../error.js';

const REFT_MAGIC = 0x52454654; // 'REFT'
/** Exported for `reftable-compaction.ts`'s size metric, which subtracts
 *  exactly these per-version framing widths from a table's on-disk size —
 *  never a bare literal. */
export const HEADER_LENGTH_V1 = 24;
export const HEADER_LENGTH_V2 = 28;
export const FOOTER_LENGTH_V1 = 68;
export const FOOTER_LENGTH_V2 = 72;
const DIGEST_LENGTH_SHA1 = 20;
const DIGEST_LENGTH_SHA256 = 32;
/** git's `ofs-delta`-style varint accepts at most 5 continuation bytes —
 *  the same bound `delta.ts`'s `MAX_VARINT_BYTES` enforces for pack deltas. */
const MAX_VARINT_BYTES = 5;

interface VersionLayout {
  readonly headerLength: 24 | 28;
  readonly footerLength: 68 | 72;
}

/** File-format-version → its header/footer byte lengths, mirroring midx's
 *  `HASH_VERSION_WIDTH` lookup-by-version shape. */
const VERSION_LAYOUT: ReadonlyMap<1 | 2, VersionLayout> = new Map([
  [1, { headerLength: HEADER_LENGTH_V1, footerLength: FOOTER_LENGTH_V1 }],
  [2, { headerLength: HEADER_LENGTH_V2, footerLength: FOOTER_LENGTH_V2 }],
]);

/** `hash_id` text → the digest width it implies. */
const HASH_DIGEST_LENGTH: ReadonlyMap<'sha1' | 's256', 20 | 32> = new Map([
  ['sha1', DIGEST_LENGTH_SHA1],
  ['s256', DIGEST_LENGTH_SHA256],
]);

const HASH_ID_TEXT: ReadonlyMap<string, 'sha1' | 's256'> = new Map([
  ['sha1', 'sha1'],
  ['s256', 's256'],
]);

export interface ReftableHeader {
  readonly version: 1 | 2;
  readonly blockSize: number;
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
  readonly hashId: 'sha1' | 's256';
  readonly headerLength: 24 | 28;
  readonly digestLength: 20 | 32;
}

export interface ReftableFooter {
  readonly refIndexPosition: number;
  readonly objPosition: number;
  readonly objIdLength: number;
  readonly objIndexPosition: number;
  readonly logPosition: number;
  readonly logIndexPosition: number;
}

export interface Reftable {
  readonly header: ReftableHeader;
  readonly footer: ReftableFooter;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

/** Shared with `reftable-block.ts`'s restart-offset and record-count reads —
 *  the only `uint24` reader in `src/domain`. */
export function readUint24(view: DataView, offset: number): number {
  return (view.getUint8(offset) << 16) | view.getUint16(offset + 1);
}

/**
 * `hash_id` (v2 only) is read as raw 4-byte text and narrowed to the closed
 * `'sha1' | 's256'` union git actually writes. The spec does not require a
 * reader to validate this field, but every other binary-parser module in
 * this codebase gates any field that becomes a narrow return type (compare
 * `midx.ts`'s `hashVersion` and `rev-index.ts`'s `hashId`) — an unrecognized
 * 4 bytes here is closest in kind to an unrecognized header version, so it
 * reuses the `'version'` check rather than widening `ReftableCheck`.
 */
function readHashId(bytes: Uint8Array, offset: number): 'sha1' | 's256' {
  const text = decode(bytes.subarray(offset, offset + 4));
  const hashId = HASH_ID_TEXT.get(text);
  if (hashId === undefined) {
    throw invalidReftable('version', `unrecognized hash id: ${text}`);
  }
  return hashId;
}

function readHeader(
  bytes: Uint8Array,
  view: DataView,
  version: 1 | 2,
  layout: VersionLayout,
): ReftableHeader {
  const blockSize = readUint24(view, 5);
  const minUpdateIndex = view.getBigUint64(8);
  const maxUpdateIndex = view.getBigUint64(16);
  const hashId = version === 2 ? readHashId(bytes, 24) : 'sha1';

  return {
    version,
    blockSize,
    minUpdateIndex,
    maxUpdateIndex,
    hashId,
    headerLength: layout.headerLength,
    digestLength: HASH_DIGEST_LENGTH.get(hashId)!,
  };
}

/**
 * Verifies the footer's CRC-32 (over every preceding footer byte, including
 * its header-repeat prefix) and unpacks its five positions — `objPosition`
 * and `objIdLength` come out of one packed `uint64`. Read via `getBigUint64`
 * rather than the manual `high * 0x100000000 + low` idiom: the packed field
 * needs an exact 5-bit shift split, which crosses the 32-bit boundary and is
 * exact in `bigint` but error-prone by hand: `Number(...)` conversion is
 * safe for every position a real reftable file can hold.
 */
function readFooter(bytes: Uint8Array, view: DataView, layout: VersionLayout): ReftableFooter {
  const footerStart = bytes.length - layout.footerLength;
  const crcCoveredEnd = footerStart + layout.footerLength - 4;

  const computedCrc = crc32(bytes.subarray(footerStart, crcCoveredEnd));
  const storedCrc = view.getUint32(crcCoveredEnd);
  if (computedCrc !== storedCrc) {
    throw invalidReftable(
      'footer-crc',
      `footer CRC-32 mismatch: computed 0x${computedCrc.toString(16)}, stored 0x${storedCrc.toString(16)}`,
    );
  }

  const fieldsStart = footerStart + layout.headerLength;
  const packedObj = view.getBigUint64(fieldsStart + 8);

  return {
    refIndexPosition: Number(view.getBigUint64(fieldsStart)),
    objPosition: Number(packedObj >> 5n),
    objIdLength: Number(packedObj & 0x1fn),
    objIndexPosition: Number(view.getBigUint64(fieldsStart + 16)),
    logPosition: Number(view.getBigUint64(fieldsStart + 24)),
    logIndexPosition: Number(view.getBigUint64(fieldsStart + 32)),
  };
}

/**
 * Parses a reftable stack file's bytes into its header and footer fields.
 * Every `DataView` read is proved in-bounds by an earlier gate — a
 * `RangeError` escaping this function is a defect, never an expected error
 * path. Ref/index/obj block record grammar is not decoded here (Part 3).
 */
export function parseReftable(bytes: Uint8Array): Reftable {
  if (bytes.length < HEADER_LENGTH_V1) {
    throw invalidReftable(
      'truncated',
      `truncated: file too short for a reftable header: ${bytes.length} bytes`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0);
  if (magic !== REFT_MAGIC) {
    throw invalidReftable(
      'magic',
      `invalid magic: expected 0x${REFT_MAGIC.toString(16)}, got 0x${magic.toString(16).padStart(8, '0')}`,
    );
  }

  const version = view.getUint8(4);
  if (version !== 1 && version !== 2) {
    throw invalidReftable('version', `unsupported version: expected 1 or 2, got ${version}`);
  }

  const layout = VERSION_LAYOUT.get(version)!;
  if (bytes.length < layout.headerLength + layout.footerLength) {
    throw invalidReftable(
      'truncated',
      `truncated: file too short for its own header and footer: ${bytes.length} bytes, needs at least ${layout.headerLength + layout.footerLength}`,
    );
  }

  const header = readHeader(bytes, view, version, layout);
  const footer = readFooter(bytes, view, layout);

  return { header, footer, _bytes: bytes, _view: view };
}

/** The one-character block type (`'r'` ref, `'i'` index, `'o'` obj, `'g'`
 *  log) at `offset` — a trusted read, exactly as `blockLengthAt`'s: the
 *  caller (Part 3's block walker) owns bounds and type validation. */
export function blockTypeAt(reftable: Reftable, offset: number): string {
  return String.fromCharCode(reftable._view.getUint8(offset));
}

/**
 * The `uint24` `block_len` declared at `offset` (immediately after the
 * 1-byte block type). For the FIRST block in the file, this length includes
 * the file header's own bytes (24 or 28); every later block's declared
 * length is its own bytes alone.
 */
export function blockLengthAt(reftable: Reftable, offset: number): number {
  return readUint24(reftable._view, offset + 1);
}

/**
 * Decodes one `ofs-delta`-style varint at `offset` — identical to the pack
 * `OFS_DELTA` base-distance encoding (`pack-entry.ts`'s `decodeOfsDistance`):
 * `val = buf[p] & 0x7f; while (buf[p] & 0x80) { p++; val = ((val + 1) << 7) |
 * (buf[p] & 0x7f) }`. Returns the house cursor idiom so a caller chains reads
 * without recomputing the offset.
 */
export function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly nextOffset: number } {
  if (offset < 0 || offset >= bytes.length) {
    throw invalidReftable('truncated', `varint truncated at byte ${offset}`);
  }

  let pos = offset;
  let value = bytes[pos]! & 0x7f;
  let bytesRead = 1;

  while ((bytes[pos]! & 0x80) !== 0) {
    if (bytesRead >= MAX_VARINT_BYTES) {
      throw invalidReftable(
        'varint-overflow',
        `varint at byte ${offset} exceeds ${MAX_VARINT_BYTES} bytes`,
      );
    }
    pos += 1;
    if (pos >= bytes.length) {
      throw invalidReftable('truncated', `varint truncated at byte ${offset}`);
    }
    // `(value + 1) * 128 + byte` rather than `((value + 1) << 7) | byte`:
    // JS's bitwise operators coerce both operands through ToInt32 first, so
    // once the accumulator crosses 2**31 the `<<`/`|` form silently wraps to
    // a negative number instead of continuing the true (and, at 5 bytes,
    // well within float64's exact-integer range) arithmetic value.
    value = (value + 1) * 128 + (bytes[pos]! & 0x7f);
    bytesRead += 1;
  }

  return { value, nextOffset: pos + 1 };
}

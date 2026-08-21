/**
 * Hand-built-bytes writer for the on-disk reftable stack-file format — header,
 * footer, and non-log block framing. Every size this module defaults to is
 * measured against `git init --ref-format=reftable` (git 2.55.0, SHA-1 and
 * SHA-256), not derived from the spec prose alone.
 *
 * Kept free of `fast-check` (and of any other test-only dependency) on
 * purpose: the parity scenarios reach this writer, and the Deno, Bun and
 * `workerd` drivers resolve the whole scenario graph strictly from source —
 * a dev-dependency anywhere in that graph fails the run before a single
 * assertion executes. The generators that DO need `fast-check` arrive in a
 * later part and live in `test/unit/domain/refs/reftable`, which re-exports
 * this writer so existing importers keep one entry point.
 *
 * Imports carry explicit `.ts` extensions, the convention of every
 * parity-reachable module.
 */
import { encode } from '../../../src/domain/objects/encoding.ts';
import { crc32 } from '../../../src/domain/storage/crc32.ts';

const REFT_MAGIC_TEXT = 'REFT';
const HEADER_LENGTH_V1 = 24;
const HEADER_LENGTH_V2 = 28;
const FOOTER_LENGTH_V1 = 68;
const FOOTER_LENGTH_V2 = 72;
const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_UPDATE_INDEX = 1n;

function writeUint24(view: DataView, offset: number, value: number): void {
  view.setUint8(offset, (value >>> 16) & 0xff);
  view.setUint16(offset + 1, value & 0xffff);
}

function writeUint64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value);
}

export interface ReftableHeaderSpec {
  readonly version: 1 | 2;
  readonly blockSize?: number;
  readonly minUpdateIndex?: bigint;
  readonly maxUpdateIndex?: bigint;
  readonly hashId?: 'sha1' | 's256';
}

/** Writer for the 24-byte (v1) / 28-byte (v2) reftable file header — also
 *  the literal prefix the footer repeats. */
export function buildReftableHeader(spec: ReftableHeaderSpec): Uint8Array {
  const headerLength = spec.version === 1 ? HEADER_LENGTH_V1 : HEADER_LENGTH_V2;
  const bytes = new Uint8Array(headerLength);
  const view = new DataView(bytes.buffer);
  bytes.set(encode(REFT_MAGIC_TEXT), 0);
  view.setUint8(4, spec.version);
  writeUint24(view, 5, spec.blockSize ?? DEFAULT_BLOCK_SIZE);
  writeUint64(view, 8, spec.minUpdateIndex ?? DEFAULT_UPDATE_INDEX);
  writeUint64(view, 16, spec.maxUpdateIndex ?? DEFAULT_UPDATE_INDEX);
  if (spec.version === 2) {
    bytes.set(encode(spec.hashId ?? 'sha1'), 24);
  }
  return bytes;
}

export interface ReftableBlockSpec {
  readonly type: 'r' | 'i' | 'o' | 'g';
  /** Opaque `ref_record+`/`index_record+` bytes — this codec layer never
   *  interprets record grammar, only block framing. */
  readonly recordBytes: Uint8Array;
  readonly restartOffsets: ReadonlyArray<number>;
  /** Overrides the declared `block_len` — for the first block this must be
   *  `headerLength + <this block's own byte length>` (the spec's "first
   *  block includes the file header" rule); defaults to the block's own
   *  byte length, correct for every block after the first. */
  readonly declaredLength?: number;
}

/** Writer for one non-log block: `type | uint24(block_len) | record+ |
 *  uint24(restart_offset)+ | uint16(restart_count)`. No padding — callers
 *  needing aligned files append zero bytes themselves. */
export function buildReftableBlock(spec: ReftableBlockSpec): Uint8Array {
  const restartBytes = spec.restartOffsets.length * 3;
  const length = 1 + 3 + spec.recordBytes.length + restartBytes + 2;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes[0] = spec.type.charCodeAt(0);
  writeUint24(view, 1, spec.declaredLength ?? length);
  bytes.set(spec.recordBytes, 4);
  let cursor = 4 + spec.recordBytes.length;
  for (const offset of spec.restartOffsets) {
    writeUint24(view, cursor, offset);
    cursor += 3;
  }
  view.setUint16(cursor, spec.restartOffsets.length);
  return bytes;
}

/**
 * The 23-byte HEAD-symref `ref_record` git 2.55.0 writes into a freshly
 * initialized `--ref-format=reftable` repository (`refs/heads/main`,
 * identical for SHA-1 and SHA-256) — captured verbatim from
 * `git init --ref-format=reftable` in a throwaway directory. Opaque to this
 * codec layer (ref-record grammar arrives in a later part); reused here only
 * so the default single-block fixture matches a real git file byte-for-byte
 * in total size and framing.
 */
const HEAD_SYMREF_RECORD_BYTES = Uint8Array.from([
  0x00, 0x23, 0x48, 0x45, 0x41, 0x44, 0x00, 0x0f, 0x72, 0x65, 0x66, 0x73, 0x2f, 0x68, 0x65, 0x61,
  0x64, 0x73, 0x2f, 0x6d, 0x61, 0x69, 0x6e,
]);

export interface ReftableFooterSpec {
  readonly refIndexPosition?: number;
  readonly objPosition?: number;
  readonly objIdLength?: number;
  readonly objIndexPosition?: number;
  readonly logPosition?: number;
  readonly logIndexPosition?: number;
}

export interface ReftableSpec extends ReftableHeaderSpec, ReftableFooterSpec {
  /** Raw block bytes in file order, immediately after the header. Defaults
   *  to a single ref block shaped exactly like git's own post-`init` table
   *  (measured: 124 bytes total at v1, footer at 56; 132 bytes at v2, footer
   *  at 60). */
  readonly blocks?: ReadonlyArray<Uint8Array>;
}

function defaultBlocks(headerLength: number): ReadonlyArray<Uint8Array> {
  const recordStart = headerLength + 4;
  const ownLength = 1 + 3 + HEAD_SYMREF_RECORD_BYTES.length + 3 + 2;
  return [
    buildReftableBlock({
      type: 'r',
      recordBytes: HEAD_SYMREF_RECORD_BYTES,
      restartOffsets: [recordStart],
      declaredLength: headerLength + ownLength,
    }),
  ];
}

/**
 * Writer for a complete reftable stack file — the model for
 * `parseReftable`'s round-trip oracle. With no explicit `blocks`, produces
 * the measured empty-repository fixture (a single HEAD-symref ref block);
 * passing `blocks: []` produces a literally empty table (header immediately
 * followed by footer, per the spec's "Empty tables" section).
 */
export function buildReftable(spec: ReftableSpec): Uint8Array {
  const header = buildReftableHeader(spec);
  const blocks = spec.blocks ?? defaultBlocks(header.length);
  const footerLength = spec.version === 1 ? FOOTER_LENGTH_V1 : FOOTER_LENGTH_V2;
  const bodyLength = blocks.reduce((sum, block) => sum + block.length, 0);

  const bytes = new Uint8Array(header.length + bodyLength + footerLength);
  bytes.set(header, 0);
  let cursor = header.length;
  for (const block of blocks) {
    bytes.set(block, cursor);
    cursor += block.length;
  }

  const footerStart = cursor;
  bytes.set(header, footerStart);
  const view = new DataView(bytes.buffer);
  const fieldsStart = footerStart + header.length;
  writeUint64(view, fieldsStart, BigInt(spec.refIndexPosition ?? 0));
  const packedObj = (BigInt(spec.objPosition ?? 0) << 5n) | BigInt(spec.objIdLength ?? 0);
  writeUint64(view, fieldsStart + 8, packedObj);
  writeUint64(view, fieldsStart + 16, BigInt(spec.objIndexPosition ?? 0));
  writeUint64(view, fieldsStart + 24, BigInt(spec.logPosition ?? 0));
  writeUint64(view, fieldsStart + 32, BigInt(spec.logIndexPosition ?? 0));
  const crcCoveredEnd = fieldsStart + 40;
  const crc = crc32(bytes.subarray(footerStart, crcCoveredEnd));
  view.setUint32(crcCoveredEnd, crc);

  return bytes;
}

import { invalidPackBitmap } from './error.js';
import { type EwahStream, readEwahStream } from './ewah.js';

const BITMAP_MAGIC = 0x4249544d; // 'BITM'
const HEADER_SIZE = 12; // magic(4) + version(2) + optionFlags(2) + entryCount(4)
const ENTRY_FIXED_SIZE = 6; // u32 position + u8 xorOffset + u8 flags
const FULL_DAG_FLAG = 0x1;

export interface PackBitmap {
  readonly version: 1;
  readonly optionFlags: number;
  readonly entryCount: number;
  readonly digestLength: number;
  /** The embedded pack (or midx) checksum. Retained, never compared. */
  readonly checksum: Uint8Array;
  /** The four type streams, in order: commits, trees, blobs, tags. */
  readonly typeStreams: readonly [EwahStream, EwahStream, EwahStream, EwahStream];
  /** Byte offset of the first per-commit entry header. */
  readonly entriesOffset: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export interface BitmapEntryHeader {
  /** Index position (pack bitmap) or midx position (midx bitmap) of the commit. */
  readonly position: number;
  readonly xorOffset: number;
  readonly flags: number;
  readonly stream: EwahStream;
}

/**
 * Parses a pack (or midx) bitmap container's bytes into its structural
 * fields. The accept-set is git's accept-set: it declines exactly where
 * git's own loader would abort and shrugs everywhere git shrugs. Every
 * `DataView` read is proved in-bounds by an earlier gate — a `RangeError`
 * escaping this function is a defect, never an expected error path.
 *
 * Every per-commit `position` — read by `bitmapEntryHeaders` — and every
 * stream's declared `bitSize` are returned exactly as stored, unvalidated:
 * this parser has no object count to range-check either against. That check
 * belongs to the consumer, once it knows which pack (or midx pseudo-pack)
 * the artefact indexes.
 */
export function parsePackBitmap(bytes: Uint8Array, digestLength: number): PackBitmap {
  if (bytes.length < HEADER_SIZE + digestLength) {
    throw invalidPackBitmap('size', 'truncated: file too short for header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const signature = view.getUint32(0);
  if (signature !== BITMAP_MAGIC) {
    throw invalidPackBitmap(
      'signature',
      `invalid signature: expected 0x${BITMAP_MAGIC.toString(16)}, got 0x${signature.toString(16).padStart(8, '0')}`,
    );
  }

  const version = view.getUint16(4);
  if (version !== 1) {
    throw invalidPackBitmap('version', `unsupported version: expected 1, got ${version}`);
  }

  const optionFlags = view.getUint16(6);
  if ((optionFlags & FULL_DAG_FLAG) === 0) {
    throw invalidPackBitmap(
      'options',
      `option flags 0x${optionFlags.toString(16).padStart(4, '0')} lack the mandatory full-DAG bit`,
    );
  }

  const entryCount = view.getUint32(8);
  const checksum = bytes.subarray(HEADER_SIZE, HEADER_SIZE + digestLength);

  const typeStreams = readTypeStreams(bytes, view, HEADER_SIZE + digestLength);
  const [, , , tagsStream] = typeStreams;

  return {
    version,
    optionFlags,
    entryCount,
    digestLength,
    checksum,
    typeStreams,
    entriesOffset: tagsStream.endOffset,
    _bytes: bytes,
    _view: view,
  };
}

/**
 * Reads the four type streams — commits, trees, blobs, tags, in that order
 * — back to back, each skipped by its own `endOffset`. The empty tags
 * stream is `bitSize=0, wordCount=1`, 20 bytes rather than 12: `readEwahStream`
 * needs no special case for it, and neither does this walk.
 */
function readTypeStreams(
  bytes: Uint8Array,
  view: DataView,
  at: number,
): readonly [EwahStream, EwahStream, EwahStream, EwahStream] {
  const commits = readEwahStream(bytes, view, at);
  const trees = readEwahStream(bytes, view, commits.endOffset);
  const blobs = readEwahStream(bytes, view, trees.endOffset);
  const tags = readEwahStream(bytes, view, blobs.endOffset);
  return [commits, trees, blobs, tags];
}

/**
 * Walks `bitmap.entryCount` per-commit entry headers from `entriesOffset`.
 * Refuses with `check: 'entry'` when the fixed 6 bytes would leave the
 * buffer, when the entry's own stream is invalid, or when `xorOffset > i` —
 * the base must precede, so chains are acyclic by construction and
 * `i − xorOffset < 0` is a refusal rather than a cycle check. A non-zero
 * `xorOffset` on entry 0 is the same guard (`0 − xorOffset < 0` whenever
 * `xorOffset` is non-zero).
 *
 * Everything after the last entry — the hash cache, the lookup table, the
 * pseudo-merge table — is never reached.
 */
export function bitmapEntryHeaders(bitmap: PackBitmap): ReadonlyArray<BitmapEntryHeader> {
  const { _bytes: bytes, _view: view, entryCount, entriesOffset } = bitmap;
  const headers: BitmapEntryHeader[] = [];
  let at = entriesOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (at + ENTRY_FIXED_SIZE > bytes.length) {
      throw invalidPackBitmap(
        'entry',
        `entry ${i} header extends past end of file at offset ${at}`,
      );
    }

    const position = view.getUint32(at);
    const xorOffset = view.getUint8(at + 4);
    const flags = view.getUint8(at + 5);

    if (xorOffset > i) {
      throw invalidPackBitmap(
        'entry',
        `entry ${i} xorOffset ${xorOffset} refers to a base that has not been parsed yet`,
      );
    }

    const stream = readEntryStream(bytes, view, at + ENTRY_FIXED_SIZE, i);
    headers.push({ position, xorOffset, flags, stream });
    at = stream.endOffset;
  }

  return headers;
}

/**
 * `readEwahStream` skipped the same way, but any refusal is reclassified
 * from `check: 'stream'` to `check: 'entry'`: from a consumer's perspective
 * a corrupt per-commit stream is a corrupt entry, not a corrupt header
 * stream — the four type streams own `'stream'`.
 */
function readEntryStream(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  entryIndex: number,
): EwahStream {
  try {
    return readEwahStream(bytes, view, at);
  } catch {
    throw invalidPackBitmap(
      'entry',
      `entry ${entryIndex} has an invalid embedded stream at offset ${at}`,
    );
  }
}

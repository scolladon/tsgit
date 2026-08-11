/**
 * Discovers, bounds and classifies the fault of a pack's sibling artefacts —
 * today the `.rev` reverse index; the pack and multi-pack-index bitmaps join
 * it later. Presence is decided by the caller (the same sibling-file-name set
 * `scanPacks` already builds, no extra `readdir`/`stat`) and passed in, so a
 * loader here never re-derives it from the filesystem.
 */
import { TsgitError, type TsgitErrorData } from '../../../domain/error.js';
import { bytesToHex } from '../../../domain/objects/encoding.js';
import {
  invalidPackBitmap,
  invalidPackRevIndex,
  type MultiPackIndex,
  type PackRevIndex,
  parsePackRevIndex,
  REASON_REV_INDEX_CORRUPT,
  REASON_REV_INDEX_TOO_SMALL,
  REV_HEADER_SIZE,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { exceedsMaxBitmapBytes, REASON_BITMAP_EXCEEDS_MAX } from '../validators.js';

export type ArtefactLoad<T> =
  | { readonly kind: 'usable'; readonly value: T; readonly bytes: Uint8Array }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'refused'; readonly data: TsgitErrorData };

const ABSENT: ArtefactLoad<never> = { kind: 'absent' };
const UNREADABLE: ArtefactLoad<never> = { kind: 'unreadable' };

const refused = (data: TsgitErrorData): ArtefactLoad<never> => ({ kind: 'refused', data });

/**
 * Classifies a fault from `stat`/`read`/a parser against the positive
 * allow-list this loader recognises — `FILE_NOT_FOUND`, `PERMISSION_DENIED`,
 * `UNSUPPORTED_OPERATION` and the artefact's own parse-error code.
 * `PERMISSION_DENIED` and `UNSUPPORTED_OPERATION` both mean "cannot tell",
 * never "corrupt" — silently `unreadable`, exactly as an inaccessible `.idx`
 * is silent at its own layer. Anything else is a defect, not an expected
 * fault, and must propagate.
 */
function classifyFault(err: unknown): ArtefactLoad<never> {
  if (!(err instanceof TsgitError)) throw err;
  switch (err.data.code) {
    case 'FILE_NOT_FOUND':
      return ABSENT;
    case 'PERMISSION_DENIED':
    case 'UNSUPPORTED_OPERATION':
      return UNREADABLE;
    case 'INVALID_PACK_REV_INDEX':
      return refused(err.data);
    default:
      throw err;
  }
}

/** The same too-small/corrupt boundary `parsePackRevIndex` itself draws,
 *  applied to a length the parser never sees — the bounded read caps the
 *  allocation at the formula, so a hostile size is refused on the length it
 *  came back with rather than on its own claim. */
function revIndexSizeFault(size: number, digestLength: number): TsgitErrorData {
  return size < REV_HEADER_SIZE + 2 * digestLength
    ? invalidPackRevIndex('size', REASON_REV_INDEX_TOO_SMALL).data
    : invalidPackRevIndex('size', REASON_REV_INDEX_CORRUPT).data;
}

/**
 * Never rejects and never logs: every fault is a value, and the CALLER
 * decides whether it becomes a finding or a warning. A log here would
 * double-report.
 *
 * Body, in order: `present === false` ⇒ absent (no I/O); ONE bounded read of
 * `12 + 4·objectCount + 2·digestLength` plus a byte, whose
 * `FILE_NOT_FOUND`/`PERMISSION_DENIED`/`UNSUPPORTED_OPERATION` ⇒ classified
 * above; a received length disagreeing with that exact size ⇒ refused;
 * `parsePackRevIndex` — any `INVALID_PACK_REV_INDEX` ⇒ refused carrying its
 * data.
 *
 * One read, not a stat and then a read. This artefact's size is a pure
 * function of `objectCount` and `digestLength`, so asking for exactly one
 * byte more than it can legally be does every job the stat did: the request
 * itself bounds the allocation before any byte is read, a short file comes
 * back short, and an oversized one comes back exactly one byte long. It also
 * closes the window the stat opened — the length that decides the verdict
 * and the bytes that get parsed now come from the same read, so a file that
 * changes size between the two can no longer be judged on a stale
 * measurement.
 *
 * Load-bearing precondition: every `FileSystem` adapter clamps an over-long
 * slice to the file's real length rather than rejecting it or zero-padding
 * (node returns a `bytesRead`-length view, memory takes `Math.min`, browser
 * leans on `Blob.slice`). An adapter that padded instead would make a short
 * `.rev` indistinguishable from an exact-sized one.
 */
export async function loadPackRevIndex(
  ctx: Context,
  revPath: string,
  present: boolean,
  digestLength: number,
  objectCount: number,
): Promise<ArtefactLoad<PackRevIndex>> {
  if (!present) return ABSENT;

  const expectedSize = REV_HEADER_SIZE + 4 * objectCount + 2 * digestLength;

  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.readSlice(revPath, 0, expectedSize + 1);
  } catch (err) {
    return classifyFault(err);
  }

  if (bytes.length !== expectedSize) {
    return refused(revIndexSizeFault(bytes.length, digestLength));
  }

  try {
    return { kind: 'usable', value: parsePackRevIndex(bytes, digestLength, objectCount), bytes };
  } catch (err) {
    return classifyFault(err);
  }
}

const bitmapSizeFault = (): TsgitErrorData =>
  invalidPackBitmap('size', REASON_BITMAP_EXCEEDS_MAX).data;

/**
 * Never rejects, never logs, never parses: this loader's entire job is
 * presence, a hostile-size ceiling and the raw bytes — the checksum-only
 * obligation the `fsck` bitmap pass draws around this artefact belongs
 * entirely to that pass, not here.
 *
 * Body, in order: `present === false` ⇒ absent (no I/O); `stat` a
 * `FILE_NOT_FOUND`/`PERMISSION_DENIED`/`UNSUPPORTED_OPERATION` ⇒ classified
 * exactly as `loadPackRevIndex` classifies the same three; a size over
 * `exceedsMaxBitmapBytes`'s `objectCount`-scaled ceiling ⇒ refused before
 * the read; `read`; the same ceiling re-checked against the bytes actually
 * received (TOCTOU).
 */
export async function loadBitmapBytes(
  ctx: Context,
  path: string,
  present: boolean,
  objectCount: number,
): Promise<ArtefactLoad<Uint8Array>> {
  if (!present) return ABSENT;

  let statSize: number;
  try {
    statSize = (await ctx.fs.stat(path)).size;
  } catch (err) {
    return classifyFault(err);
  }

  if (exceedsMaxBitmapBytes(statSize, objectCount)) {
    return refused(bitmapSizeFault());
  }

  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(path);
  } catch (err) {
    return classifyFault(err);
  }

  if (exceedsMaxBitmapBytes(bytes.length, objectCount)) {
    return refused(bitmapSizeFault());
  }

  return { kind: 'usable', value: bytes, bytes };
}

/**
 * The midx bitmap's filename, composed from the in-use layer's STORED
 * trailer bytes — never a recomputed digest (Pin K rule 3). A rename, or a
 * midx whose own trailer disagrees with its bytes, both simply compose a
 * name that names no file on disk; there is no special case for either.
 */
export function midxBitmapName(head: MultiPackIndex): string {
  const bodyEnd = head._bytes.length - head.digestLength;
  return `multi-pack-index-${bytesToHex(head._bytes.subarray(bodyEnd))}.bitmap`;
}

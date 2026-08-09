/**
 * Discovers, bounds and classifies the fault of a pack's sibling artefacts —
 * today the `.rev` reverse index; the pack and multi-pack-index bitmaps join
 * it later. Presence is decided by the caller (the same sibling-file-name set
 * `scanPacks` already builds, no extra `readdir`/`stat`) and passed in, so a
 * loader here never re-derives it from the filesystem.
 */
import { TsgitError, type TsgitErrorData } from '../../../domain/error.js';
import {
  invalidPackRevIndex,
  type PackRevIndex,
  parsePackRevIndex,
  REASON_REV_INDEX_CORRUPT,
  REASON_REV_INDEX_TOO_SMALL,
  REV_HEADER_SIZE,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';

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
 *  applied to a size the parser never sees — a pre-read stat rejects a
 *  hostile size before its bytes are ever allocated. */
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
 * Body, in order: `present === false` ⇒ absent (no I/O); `stat` a
 * `FILE_NOT_FOUND`/`PERMISSION_DENIED`/`UNSUPPORTED_OPERATION` ⇒ classified
 * above; a size disagreeing with `12 + 4·objectCount + 2·digestLength` ⇒
 * refused before the read; `read`; the same size re-checked against the
 * bytes actually received (TOCTOU); `parsePackRevIndex` — any
 * `INVALID_PACK_REV_INDEX` ⇒ refused carrying its data.
 */
export async function loadPackRevIndex(
  ctx: Context,
  revPath: string,
  present: boolean,
  digestLength: number,
  objectCount: number,
): Promise<ArtefactLoad<PackRevIndex>> {
  if (!present) return ABSENT;

  let statSize: number;
  try {
    statSize = (await ctx.fs.stat(revPath)).size;
  } catch (err) {
    return classifyFault(err);
  }

  const expectedSize = REV_HEADER_SIZE + 4 * objectCount + 2 * digestLength;
  if (statSize !== expectedSize) {
    return refused(revIndexSizeFault(statSize, digestLength));
  }

  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(revPath);
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

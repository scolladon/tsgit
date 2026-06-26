/**
 * Pure zip serializer — raw DEFLATE injection.
 *
 * Consumes an `ArchiveResult` stream and yields `AsyncIterable<Uint8Array>`
 * bytes byte-equal to `git archive --format=zip` output (node adapter, TZ=UTC).
 *
 * Faithfulness matrix Z pinned against git 2.54.0 — see docs/design/archive.md.
 * Rendering inputs (prefix, mtime, tzOffsetMinutes, level) are caller-supplied.
 * No IO, no platform dependency — deflateRaw is injected.
 *
 * Runtime imports: crc32 from ../storage/crc32.js (in-tree, no new deps).
 */
import { crc32 } from '../storage/crc32.js';
import type { ArchiveEntry, ArchiveResult } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ZipDeps {
  /** Raw DEFLATE (RFC 1951) — no zlib header, no adler32. Injected by caller. */
  readonly deflateRaw: (data: Uint8Array, level?: number) => Promise<Uint8Array>;
}

export interface ZipOptions {
  /** Prepended to every path; synthesises a top `<prefix>` directory entry. Default: `''`. */
  readonly prefix?: string;
  /** Epoch seconds stamped into every entry. Default: `result.commitTime ?? 0`. */
  readonly mtime?: number;
  /**
   * Minutes added to mtime before computing DOS date/time fields.
   * git uses `localtime` so the DOS breakdown is TZ-dependent; pass the
   * caller's UTC offset to reproduce byte-for-byte. Default: `0` (UTC).
   */
  readonly tzOffsetMinutes?: number;
  /** Compression level forwarded to deflateRaw. Default: adapter default. */
  readonly level?: number;
}

// ---------------------------------------------------------------------------
// ZIP signatures
// ---------------------------------------------------------------------------

/** PK\x03\x04 — local file header signature. */
const SIG_LOCAL = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
/** PK\x01\x02 — central directory header signature. */
const SIG_CENTRAL = new Uint8Array([0x50, 0x4b, 0x01, 0x02]);
/** PK\x05\x06 — end of central directory signature. */
const SIG_EOCD = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Zip 1.0 — only features used. */
const VERSION_NEEDED = 10;
/** No data descriptor (bit-3 clear), no encryption. */
const FLAGS = 0x0000;
/** Store — no compression. */
const METHOD_STORE = 0;
/** Deflate — raw DEFLATE. */
const METHOD_DEFLATE = 8;

/** host-OS 0 = MS-DOS (spec 0). Used for regular, dir, gitlink. */
const VERSION_MADE_BY_MSDOS = 0x0000;
/** host-OS 3 = Unix, spec 23 (2.3). Used for exec and symlink. */
const VERSION_MADE_BY_UNIX = 0x0317;

// External attributes (table Z, docs/design/archive.md)
/** Regular file — mode not encoded in external attrs. */
const EXTERNAL_ATTR_REGULAR = 0x00000000;
/** Exec: 0o100755 << 16 = 0x81ed0000. */
const EXTERNAL_ATTR_EXEC = 0x81ed0000;
/** Symlink: 0o120777 << 16 = 0xa1ff0000 (raw git mode, no umask). */
const EXTERNAL_ATTR_SYMLINK = 0xa1ff0000;
/** Directory or gitlink: DOS directory attribute. */
const EXTERNAL_ATTR_DIR = 0x00000010;

// Internal attributes
/** text: no NUL present in content. */
const INTERNAL_ATTR_TEXT = 0x0001;
/** binary: NUL present, or dir/gitlink. */
const INTERNAL_ATTR_BINARY = 0x0000;

// UT extra field constants
/** Extra-field id for the "Unix extended timestamp" (`UT`) field. */
const UT_EXTRA_ID = 0x5455;
/** Size of the UT data block (flag + mtime u32). */
const UT_EXTRA_DATA_SIZE = 5;
/** Flag byte: mod-time only (no atime or ctime). */
const UT_EXTRA_FLAG_MOD_TIME = 0x01;
/** Total bytes of the UT extra field: 2 (id) + 2 (size) + 1 (flag) + 4 (mtime). */
const UT_EXTRA_TOTAL = 9;

// Fixed header sizes
const LOCAL_HEADER_FIXED = 30;
const CENTRAL_ENTRY_FIXED = 46;
const EOCD_FIXED = 22;

// ---------------------------------------------------------------------------
// Default option values
// ---------------------------------------------------------------------------

const DEFAULT_PREFIX = '';
const DEFAULT_TZ_OFFSET_MINUTES = 0;

// ---------------------------------------------------------------------------
// Little-endian field writers
// ---------------------------------------------------------------------------

function writeU16LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------
// DOS-time encoder
// ---------------------------------------------------------------------------

interface DosTime {
  readonly time: number;
  readonly date: number;
}

/**
 * Convert a Unix epoch + TZ offset to a DOS time/date pair.
 *
 * git uses `localtime` so DOS fields are TZ-dependent.  We replicate this
 * deterministically: add `tzOffsetMinutes * 60` to the epoch, then read
 * the result's UTC hour/minute/second/day/month/year fields.
 * The UT extra-field timestamp is ALWAYS the raw epoch (TZ-independent).
 */
function epochToDosTime(mtime: number, tzOffsetMinutes: number): DosTime {
  const adjustedMs = (mtime + tzOffsetMinutes * 60) * 1000;
  const d = new Date(adjustedMs);
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const sec2 = Math.floor(d.getUTCSeconds() / 2);
  const time = (hours << 11) | (minutes << 5) | sec2;
  const year = d.getUTCFullYear() - 1980;
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const date = (year << 9) | (month << 5) | day;
  return { time, date };
}

// ---------------------------------------------------------------------------
// UT extra field
// ---------------------------------------------------------------------------

/** Build the 9-byte UT ("Unix extended timestamp") extra field. */
function buildUtExtra(mtime: number): Uint8Array {
  const extra = new Uint8Array(UT_EXTRA_TOTAL);
  writeU16LE(extra, 0, UT_EXTRA_ID);
  writeU16LE(extra, 2, UT_EXTRA_DATA_SIZE);
  extra[4] = UT_EXTRA_FLAG_MOD_TIME;
  writeU32LE(extra, 5, mtime);
  return extra;
}

// ---------------------------------------------------------------------------
// Name encoding
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

function encodeName(name: string): Uint8Array {
  return TEXT_ENCODER.encode(name);
}

// ---------------------------------------------------------------------------
// Local file header
// ---------------------------------------------------------------------------

function buildLocalHeader(
  name: Uint8Array,
  method: number,
  dosTime: DosTime,
  crc: number,
  csize: number,
  usize: number,
  utExtra: Uint8Array,
): Uint8Array {
  const namelen = name.length;
  const extralen = utExtra.length;
  const buf = new Uint8Array(LOCAL_HEADER_FIXED + namelen + extralen);
  let off = 0;
  buf.set(SIG_LOCAL, off);
  off += 4;
  writeU16LE(buf, off, VERSION_NEEDED);
  off += 2;
  writeU16LE(buf, off, FLAGS);
  off += 2;
  writeU16LE(buf, off, method);
  off += 2;
  writeU16LE(buf, off, dosTime.time);
  off += 2;
  writeU16LE(buf, off, dosTime.date);
  off += 2;
  writeU32LE(buf, off, crc);
  off += 4;
  writeU32LE(buf, off, csize);
  off += 4;
  writeU32LE(buf, off, usize);
  off += 4;
  writeU16LE(buf, off, namelen);
  off += 2;
  writeU16LE(buf, off, extralen);
  off += 2;
  buf.set(name, off);
  off += namelen;
  buf.set(utExtra, off);
  return buf;
}

// ---------------------------------------------------------------------------
// Central directory entry
// ---------------------------------------------------------------------------

function buildCentralEntry(
  name: Uint8Array,
  method: number,
  dosTime: DosTime,
  crc: number,
  csize: number,
  usize: number,
  internalAttr: number,
  externalAttr: number,
  versionMadeBy: number,
  localOffset: number,
  utExtra: Uint8Array,
): Uint8Array {
  const namelen = name.length;
  const extralen = utExtra.length;
  const buf = new Uint8Array(CENTRAL_ENTRY_FIXED + namelen + extralen);
  let off = 0;
  buf.set(SIG_CENTRAL, off);
  off += 4;
  writeU16LE(buf, off, versionMadeBy);
  off += 2;
  writeU16LE(buf, off, VERSION_NEEDED);
  off += 2;
  writeU16LE(buf, off, FLAGS);
  off += 2;
  writeU16LE(buf, off, method);
  off += 2;
  writeU16LE(buf, off, dosTime.time);
  off += 2;
  writeU16LE(buf, off, dosTime.date);
  off += 2;
  writeU32LE(buf, off, crc);
  off += 4;
  writeU32LE(buf, off, csize);
  off += 4;
  writeU32LE(buf, off, usize);
  off += 4;
  writeU16LE(buf, off, namelen);
  off += 2;
  writeU16LE(buf, off, extralen);
  off += 2;
  writeU16LE(buf, off, 0); // comment length
  off += 2;
  writeU16LE(buf, off, 0); // disk start
  off += 2;
  writeU16LE(buf, off, internalAttr);
  off += 2;
  writeU32LE(buf, off, externalAttr);
  off += 4;
  writeU32LE(buf, off, localOffset);
  off += 4;
  buf.set(name, off);
  off += namelen;
  buf.set(utExtra, off);
  return buf;
}

// ---------------------------------------------------------------------------
// EOCD
// ---------------------------------------------------------------------------

function buildEocd(
  entryCount: number,
  cdSize: number,
  cdOffset: number,
  comment: string,
): Uint8Array {
  const commentBytes = TEXT_ENCODER.encode(comment);
  const buf = new Uint8Array(EOCD_FIXED + commentBytes.length);
  let off = 0;
  buf.set(SIG_EOCD, off);
  off += 4;
  writeU16LE(buf, off, 0); // disk number
  off += 2;
  writeU16LE(buf, off, 0); // start disk
  off += 2;
  writeU16LE(buf, off, entryCount); // entries on disk
  off += 2;
  writeU16LE(buf, off, entryCount); // total entries
  off += 2;
  writeU32LE(buf, off, cdSize);
  off += 4;
  writeU32LE(buf, off, cdOffset);
  off += 4;
  writeU16LE(buf, off, commentBytes.length);
  off += 2;
  buf.set(commentBytes, off);
  return buf;
}

// ---------------------------------------------------------------------------
// NUL-presence scan (text detection)
// ---------------------------------------------------------------------------

/**
 * True iff `content` contains no NUL bytes (i.e. is text).
 * git uses NUL-presence only — no line-length caps.
 * Local scan; does not depend on diff-module internals.
 */
function isText(content: Uint8Array): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-entry attribute table (table Z, each arm independently tested)
// ---------------------------------------------------------------------------

interface EntryAttrs {
  readonly versionMadeBy: number;
  readonly internalAttr: number;
  readonly externalAttr: number;
}

function regularAttrs(content: Uint8Array | undefined): EntryAttrs {
  const text = content !== undefined && isText(content);
  return {
    versionMadeBy: VERSION_MADE_BY_MSDOS,
    internalAttr: text ? INTERNAL_ATTR_TEXT : INTERNAL_ATTR_BINARY,
    externalAttr: EXTERNAL_ATTR_REGULAR,
  };
}

function execAttrs(content: Uint8Array | undefined): EntryAttrs {
  const text = content !== undefined && isText(content);
  return {
    versionMadeBy: VERSION_MADE_BY_UNIX,
    internalAttr: text ? INTERNAL_ATTR_TEXT : INTERNAL_ATTR_BINARY,
    externalAttr: EXTERNAL_ATTR_EXEC,
  };
}

const SYMLINK_ATTRS: EntryAttrs = {
  versionMadeBy: VERSION_MADE_BY_UNIX,
  internalAttr: INTERNAL_ATTR_TEXT,
  externalAttr: EXTERNAL_ATTR_SYMLINK,
};

const DIR_ATTRS: EntryAttrs = {
  versionMadeBy: VERSION_MADE_BY_MSDOS,
  internalAttr: INTERNAL_ATTR_BINARY,
  externalAttr: EXTERNAL_ATTR_DIR,
};

function entryAttrs(entry: ArchiveEntry): EntryAttrs {
  switch (entry.mode) {
    case '100644':
      return regularAttrs(entry.content);
    case '100755':
      return execAttrs(entry.content);
    case '120000':
      return SYMLINK_ATTRS;
    case '40000':
      return DIR_ATTRS;
    case '160000':
      return DIR_ATTRS;
    default: {
      const _: never = entry.mode;
      throw new Error(`Unknown git mode: ${_}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-entry content helpers
// ---------------------------------------------------------------------------

interface EntryContent {
  readonly method: number;
  readonly compressed: Uint8Array;
  readonly contentCrc: number;
  readonly usize: number;
}

/** Compress or store entry content; always returns method-0 for dirs/gitlinks. */
async function compressEntry(
  entry: ArchiveEntry,
  deps: ZipDeps,
  level: number | undefined,
): Promise<EntryContent> {
  if (entryIsDir(entry.mode)) {
    return { method: METHOD_STORE, compressed: new Uint8Array(0), contentCrc: 0, usize: 0 };
  }
  const content = entry.content ?? new Uint8Array(0);
  const contentCrc = crc32(content);
  const usize = content.length;
  const deflated = await deps.deflateRaw(content, level);
  if (deflated.length < content.length) {
    return { method: METHOD_DEFLATE, compressed: deflated, contentCrc, usize };
  }
  return { method: METHOD_STORE, compressed: content, contentCrc, usize };
}

// ---------------------------------------------------------------------------
// Central directory record accumulator
// ---------------------------------------------------------------------------

interface CdRecord {
  readonly name: Uint8Array;
  readonly method: number;
  readonly dosTime: DosTime;
  readonly crc: number;
  readonly csize: number;
  readonly usize: number;
  readonly internalAttr: number;
  readonly externalAttr: number;
  readonly versionMadeBy: number;
  readonly localOffset: number;
  readonly utExtra: Uint8Array;
}

// ---------------------------------------------------------------------------
// Entry path helpers
// ---------------------------------------------------------------------------

function entryIsDir(mode: ArchiveEntry['mode']): boolean {
  return mode === '40000' || mode === '160000';
}

function buildEntryName(entryPath: string, prefix: string, mode: ArchiveEntry['mode']): string {
  const trailing = entryIsDir(mode) ? '/' : '';
  return `${prefix}${entryPath}${trailing}`;
}

// ---------------------------------------------------------------------------
// Public: zipArchive
// ---------------------------------------------------------------------------

/**
 * Convert an `ArchiveResult` to a zip byte stream byte-equal to
 * `git archive --format=zip` (node adapter, run under TZ=UTC with tzOffsetMinutes=0).
 *
 * Method-8 byte-identity requires `deflateRaw = NodeCompressor.deflateRaw` at
 * default level (confirmed: 20000×A blob → 37 bytes, matching git exactly).
 * Cross-adapter method-8 bytes are not pinned — only round-trip equivalence.
 *
 * Rendering inputs (prefix, mtime, tzOffsetMinutes, level) are caller-supplied;
 * defaults match git's UTC behaviour.
 */
export async function* zipArchive(
  result: ArchiveResult,
  deps: ZipDeps,
  opts?: ZipOptions,
): AsyncIterable<Uint8Array> {
  const prefix = opts?.prefix ?? DEFAULT_PREFIX;
  const mtime = opts?.mtime ?? result.commitTime ?? 0;
  const tzOffsetMinutes = opts?.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES;
  const level = opts?.level;

  const dosTime = epochToDosTime(mtime, tzOffsetMinutes);
  const utExtra = buildUtExtra(mtime);
  const records: CdRecord[] = [];
  let localOffset = 0;

  // Synthesise prefix directory entry when prefix is non-empty
  if (prefix !== '') {
    const nameBytes = encodeName(prefix);
    const localHeader = buildLocalHeader(nameBytes, METHOD_STORE, dosTime, 0, 0, 0, utExtra);
    yield localHeader;
    records.push({
      name: nameBytes,
      method: METHOD_STORE,
      dosTime,
      crc: 0,
      csize: 0,
      usize: 0,
      internalAttr: INTERNAL_ATTR_BINARY,
      externalAttr: EXTERNAL_ATTR_DIR,
      versionMadeBy: VERSION_MADE_BY_MSDOS,
      localOffset,
      utExtra,
    });
    localOffset += localHeader.length;
  }

  // Stream entries
  for await (const entry of result.entries) {
    const name = buildEntryName(entry.path, prefix, entry.mode);
    const nameBytes = encodeName(name);
    const attrs = entryAttrs(entry);

    const { method, compressed, contentCrc, usize } = await compressEntry(entry, deps, level);
    const csize = compressed.length;
    const localHeader = buildLocalHeader(
      nameBytes,
      method,
      dosTime,
      contentCrc,
      csize,
      usize,
      utExtra,
    );

    yield localHeader;
    records.push({
      name: nameBytes,
      method,
      dosTime,
      crc: contentCrc,
      csize,
      usize,
      internalAttr: attrs.internalAttr,
      externalAttr: attrs.externalAttr,
      versionMadeBy: attrs.versionMadeBy,
      localOffset,
      utExtra,
    });
    localOffset += localHeader.length;

    if (csize > 0) {
      yield compressed;
      localOffset += csize;
    }
  }

  // Emit central directory
  const cdOffset = localOffset;
  let cdSize = 0;

  for (const rec of records) {
    const cdEntry = buildCentralEntry(
      rec.name,
      rec.method,
      rec.dosTime,
      rec.crc,
      rec.csize,
      rec.usize,
      rec.internalAttr,
      rec.externalAttr,
      rec.versionMadeBy,
      rec.localOffset,
      rec.utExtra,
    );
    yield cdEntry;
    cdSize += cdEntry.length;
  }

  // EOCD — comment = commit oid when defined, empty for bare tree
  const comment = result.commit ?? '';
  yield buildEocd(records.length, cdSize, cdOffset, comment);
}

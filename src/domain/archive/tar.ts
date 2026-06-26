/**
 * Pure, zero-dependency ustar tar serializer.
 *
 * Consumes an `ArchiveResult` stream and yields `AsyncIterable<Uint8Array>`
 * bytes byte-equal to `git archive --format=tar` output.
 *
 * Faithfulness matrix T/M/P/D pinned against git 2.54.0 — see
 * docs/design/archive.md.  All rendering inputs (prefix, mtime, umask,
 * uname, gname) are caller-supplied; no IO, no platform dependency.
 *
 * Runtime imports: none (only type import from ./types.js).
 */
import type { ArchiveEntry, ArchiveResult } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TarOptions {
  /** Prepended to every path; synthesises a top `<prefix>` directory entry. Default: `''`. */
  readonly prefix?: string;
  /** Epoch seconds stamped in every header mtime. Default: `result.commitTime ?? 0`. */
  readonly mtime?: number;
  /** Mode mask applied to regular/exec/dir/gitlink (NOT symlinks). Default: `0o0002`. */
  readonly umask?: number;
  /** User name field value. Default: `'root'`. */
  readonly uname?: string;
  /** Group name field value. Default: `'root'`. */
  readonly gname?: string;
}

// ---------------------------------------------------------------------------
// Field offsets and lengths (ustar POSIX.1-1988)
// ---------------------------------------------------------------------------

const OFF_NAME = 0;
const LEN_NAME = 100;
const OFF_MODE = 100;
const LEN_MODE = 8;
const OFF_UID = 108;
const LEN_UID = 8;
const OFF_GID = 116;
const LEN_GID = 8;
const OFF_SIZE = 124;
const LEN_SIZE = 12;
const OFF_MTIME = 136;
const LEN_MTIME = 12;
const OFF_CHKSUM = 148;
const OFF_TYPEFLAG = 156;
const OFF_LINKNAME = 157;
const LEN_LINKNAME = 100;
const OFF_MAGIC = 257;
const OFF_VERSION = 263;
const OFF_UNAME = 265;
const LEN_UNAME = 32;
const OFF_GNAME = 297;
const LEN_GNAME = 32;
const OFF_DEVMAJOR = 329;
const LEN_DEVMAJOR = 8;
const OFF_DEVMINOR = 337;
const LEN_DEVMINOR = 8;
const OFF_PREFIX_FIELD = 345;
const LEN_PREFIX_FIELD = 155;
const HEADER_SIZE = 512;

// ---------------------------------------------------------------------------
// Archive blocking constants
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;
const BLOCKING_FACTOR = 20;
const RECORD_SIZE = BLOCK_SIZE * BLOCKING_FACTOR; // 10240

// ---------------------------------------------------------------------------
// Tar-fixed byte sequences
// ---------------------------------------------------------------------------

/** 'ustar\0' — ustar magic 6 bytes. */
const MAGIC = new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]);
/** '00' — ustar version 2 bytes. */
const VERSION = new Uint8Array([0x30, 0x30]);

// ---------------------------------------------------------------------------
// Typeflags
// ---------------------------------------------------------------------------

const TYPEFLAG_REGULAR = 0x30; // '0'
const TYPEFLAG_SYMLINK = 0x32; // '2'
const TYPEFLAG_DIR = 0x35; // '5'
const TYPEFLAG_PAX_GLOBAL = 0x67; // 'g'

// ---------------------------------------------------------------------------
// Mode computation (table M, git 2.54.0 verified)
// ---------------------------------------------------------------------------

/** Base mode for regular files: 0666 & ~umask = 0664 with default umask 0002. */
const MODE_REGULAR_BASE = 0o0666;
/** Base mode for exec/dir/gitlink: 0777 & ~umask = 0775 with default umask 0002. */
const MODE_MASKED_BASE = 0o0777;
/** Symlink mode: 0777, umask NOT applied. */
const MODE_SYMLINK = 0o0777;

const DEFAULT_UMASK = 0o0002;
const DEFAULT_UNAME = 'root';
const DEFAULT_GNAME = 'root';
const DEFAULT_PREFIX = '';

// ---------------------------------------------------------------------------
// PAX global header constants
// ---------------------------------------------------------------------------

const PAX_GLOBAL_NAME = 'pax_global_header';
/** "52 comment=" (11) + 40-hex oid + "\n" (1) = 52 bytes, self-inclusive. */
const PAX_RECORD_SIZE = 52;
const PAX_MODE = 0o0666;

// ---------------------------------------------------------------------------
// Path limits
// ---------------------------------------------------------------------------

const NAME_MAX = 100;
const PREFIX_MAX = 155;
const PATH_MAX_USTAR = NAME_MAX + 1 + PREFIX_MAX; // 256

// ---------------------------------------------------------------------------
// Low-level field writers
// ---------------------------------------------------------------------------

/**
 * Write `val` as a zero-padded octal string of `len-1` digits followed by
 * a NUL byte into `buf` starting at `offset`.
 */
function writeOctal(buf: Uint8Array, offset: number, len: number, val: number): void {
  const str = val.toString(8).padStart(len - 1, '0');
  for (let i = 0; i < len - 1; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
  buf[offset + len - 1] = 0x00;
}

/**
 * Write ASCII string `str` into `len` bytes at `offset`, null-padding the
 * remainder. Characters beyond `len` are silently truncated.
 */
function writeAscii(buf: Uint8Array, offset: number, len: number, str: string): void {
  const writeLen = Math.min(str.length, len);
  for (let i = 0; i < writeLen; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}

/** Write raw `bytes` into `len` bytes at `offset`, null-padding the remainder. */
function writeBytes(buf: Uint8Array, offset: number, len: number, bytes: Uint8Array): void {
  buf.set(bytes.subarray(0, Math.min(bytes.length, len)), offset);
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Compute the unsigned byte-sum checksum of a 512-byte header, treating
 * the chksum field (bytes 148-155) as 8 ASCII spaces during computation.
 */
function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (const [i, byte] of header.entries()) {
    sum += i >= OFF_CHKSUM && i < OFF_CHKSUM + 8 ? 0x20 : byte;
  }
  return sum;
}

/**
 * Write the checksum into header bytes 148-155 as:
 *   7 octal digits + NUL (0x00)
 *
 * Git uses `sprintf(header.chksum, "%07o", sum)` which produces 7 octal
 * digits followed by a null terminator (C string, 8 bytes total).  This
 * differs from the POSIX "6 digits + NUL + space" convention used by GNU
 * tar; we replicate git's `%07o` behaviour to pass byte-equality probes.
 */
function writeChecksum(header: Uint8Array): void {
  const sum = computeChecksum(header);
  const str = sum.toString(8).padStart(7, '0');
  for (let i = 0; i < 7; i++) {
    header[OFF_CHKSUM + i] = str.charCodeAt(i);
  }
  header[OFF_CHKSUM + 7] = 0x00;
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

interface HeaderParams {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly typeflag: number;
  readonly linknameBytes: Uint8Array;
  readonly uname: string;
  readonly gname: string;
  readonly prefixField: string;
}

function writeFixedFields(buf: Uint8Array, p: HeaderParams): void {
  writeAscii(buf, OFF_NAME, LEN_NAME, p.name);
  writeOctal(buf, OFF_MODE, LEN_MODE, p.mode);
  writeOctal(buf, OFF_UID, LEN_UID, 0);
  writeOctal(buf, OFF_GID, LEN_GID, 0);
  writeOctal(buf, OFF_SIZE, LEN_SIZE, p.size);
  writeOctal(buf, OFF_MTIME, LEN_MTIME, p.mtime);
  buf[OFF_TYPEFLAG] = p.typeflag;
  writeBytes(buf, OFF_LINKNAME, LEN_LINKNAME, p.linknameBytes);
}

function writeUstarFields(buf: Uint8Array, p: HeaderParams): void {
  buf.set(MAGIC, OFF_MAGIC);
  buf.set(VERSION, OFF_VERSION);
  writeAscii(buf, OFF_UNAME, LEN_UNAME, p.uname);
  writeAscii(buf, OFF_GNAME, LEN_GNAME, p.gname);
  writeOctal(buf, OFF_DEVMAJOR, LEN_DEVMAJOR, 0);
  writeOctal(buf, OFF_DEVMINOR, LEN_DEVMINOR, 0);
  writeAscii(buf, OFF_PREFIX_FIELD, LEN_PREFIX_FIELD, p.prefixField);
}

function buildHeader(p: HeaderParams): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE); // zero-initialised
  writeFixedFields(buf, p);
  writeUstarFields(buf, p);
  writeChecksum(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Path splitting
// ---------------------------------------------------------------------------

interface PathFields {
  readonly name: string;
  readonly prefixField: string;
}

/**
 * Split a path into ustar `name` (≤100) and `prefix` (≤155) fields.
 * Paths ≤100 bytes go entirely into `name`. Paths 101–256 bytes are split
 * at a '/' boundary. Paths >256 bytes are out of scope (throws).
 */
function splitPath(filePath: string): PathFields {
  if (filePath.length <= NAME_MAX) {
    return { name: filePath, prefixField: '' };
  }
  if (filePath.length > PATH_MAX_USTAR) {
    throw new Error(`Path too long for ustar archive (>${PATH_MAX_USTAR} bytes): ${filePath}`);
  }
  // Search from the latest valid split point toward the start.
  // Require a non-empty name (1 ≤ nameLen ≤ NAME_MAX) so a trailing slash on
  // a directory path is never used as the split point (git never emits an
  // empty name — it splits before the last component instead).
  for (let i = Math.min(filePath.length - 1, PREFIX_MAX); i > 0; i--) {
    const nameLen = filePath.length - i - 1;
    if (filePath[i] === '/' && nameLen >= 1 && nameLen <= NAME_MAX) {
      return { name: filePath.slice(i + 1), prefixField: filePath.slice(0, i) };
    }
  }
  throw new Error(`Cannot split path into ustar prefix+name: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Mode table M (each case independently tested, mutation-resistant)
// ---------------------------------------------------------------------------

/** Compute the tar unix permission bits for a given git mode and umask. */
function tarMode(mode: ArchiveEntry['mode'], umask: number): number {
  switch (mode) {
    case '100644':
      return MODE_REGULAR_BASE & ~umask;
    case '100755':
      return MODE_MASKED_BASE & ~umask;
    case '40000':
      return MODE_MASKED_BASE & ~umask;
    case '160000':
      return MODE_MASKED_BASE & ~umask;
    case '120000':
      return MODE_SYMLINK;
  }
}

/** Map a git mode to the ustar typeflag byte. */
function modeTypeflag(mode: ArchiveEntry['mode']): number {
  switch (mode) {
    case '100644':
    case '100755':
      return TYPEFLAG_REGULAR;
    case '120000':
      return TYPEFLAG_SYMLINK;
    case '40000':
    case '160000':
      return TYPEFLAG_DIR;
  }
}

/** True for modes that contribute a data block (regular and exec only). */
function hasDataBlock(mode: ArchiveEntry['mode']): boolean {
  return mode === '100644' || mode === '100755';
}

/** True for modes whose tar name must carry a trailing '/'. */
function needsTrailingSlash(mode: ArchiveEntry['mode']): boolean {
  return mode === '40000' || mode === '160000';
}

// ---------------------------------------------------------------------------
// Data block padding
// ---------------------------------------------------------------------------

/** Return `data` padded to the next multiple of 512. Caller ensures non-empty. */
function padTo512(data: Uint8Array): Uint8Array {
  const paddedSize = Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE;
  if (paddedSize === data.length) return data;
  const result = new Uint8Array(paddedSize);
  result.set(data);
  return result;
}

// ---------------------------------------------------------------------------
// PAX global header builders
// ---------------------------------------------------------------------------

function buildPaxHeader(mtime: number, uname: string, gname: string): Uint8Array {
  const { name, prefixField } = splitPath(PAX_GLOBAL_NAME);
  return buildHeader({
    name,
    mode: PAX_MODE,
    size: PAX_RECORD_SIZE,
    mtime,
    typeflag: TYPEFLAG_PAX_GLOBAL,
    linknameBytes: new Uint8Array(0),
    uname,
    gname,
    prefixField,
  });
}

function buildPaxData(oid: string): Uint8Array {
  const buf = new Uint8Array(BLOCK_SIZE);
  const record = `${PAX_RECORD_SIZE} comment=${oid}\n`;
  for (let i = 0; i < record.length; i++) {
    buf[i] = record.charCodeAt(i);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Entry header builder
// ---------------------------------------------------------------------------

function buildEntryHeader(
  entry: ArchiveEntry,
  fullPath: string,
  mtime: number,
  umask: number,
  uname: string,
  gname: string,
): Uint8Array {
  const { name, prefixField } = splitPath(fullPath);
  const isSymlink = entry.mode === '120000';
  const linknameBytes =
    isSymlink && entry.content !== undefined ? entry.content : new Uint8Array(0);
  const size = hasDataBlock(entry.mode) && entry.content !== undefined ? entry.content.length : 0;
  return buildHeader({
    name,
    mode: tarMode(entry.mode, umask),
    size,
    mtime,
    typeflag: modeTypeflag(entry.mode),
    linknameBytes,
    uname,
    gname,
    prefixField,
  });
}

/** Build a synthetic directory header for the prefix option. */
function buildPrefixDirHeader(
  prefix: string,
  mtime: number,
  umask: number,
  uname: string,
  gname: string,
): Uint8Array {
  const { name, prefixField } = splitPath(prefix);
  return buildHeader({
    name,
    mode: MODE_MASKED_BASE & ~umask,
    size: 0,
    mtime,
    typeflag: TYPEFLAG_DIR,
    linknameBytes: new Uint8Array(0),
    uname,
    gname,
    prefixField,
  });
}

/** Compute the full tar path for an entry (with prefix and trailing slash for dirs). */
function buildEntryPath(entryPath: string, prefix: string, mode: ArchiveEntry['mode']): string {
  const trailing = needsTrailingSlash(mode) ? '/' : '';
  return prefix + entryPath + trailing;
}

// ---------------------------------------------------------------------------
// Public: tarArchive
// ---------------------------------------------------------------------------

/**
 * Convert an `ArchiveResult` to a ustar tar byte stream byte-equal to
 * `git archive --format=tar`.
 *
 * Rendering inputs (prefix, mtime, umask, uname, gname) are caller-supplied;
 * defaults match git's behaviour.
 */
export async function* tarArchive(
  result: ArchiveResult,
  opts?: TarOptions,
): AsyncIterable<Uint8Array> {
  const prefix = opts?.prefix ?? DEFAULT_PREFIX;
  const mtime = opts?.mtime ?? result.commitTime ?? 0;
  const umask = opts?.umask ?? DEFAULT_UMASK;
  const uname = opts?.uname ?? DEFAULT_UNAME;
  const gname = opts?.gname ?? DEFAULT_GNAME;
  let byteCount = 0;

  // Pax global header — present iff result.commit is defined
  if (result.commit !== undefined) {
    yield buildPaxHeader(mtime, uname, gname);
    byteCount += BLOCK_SIZE;
    yield buildPaxData(result.commit);
    byteCount += BLOCK_SIZE;
  }

  // Synthesise prefix directory entry when prefix is non-empty
  if (prefix !== '') {
    yield buildPrefixDirHeader(prefix, mtime, umask, uname, gname);
    byteCount += BLOCK_SIZE;
  }

  // Stream archive entries
  for await (const entry of result.entries) {
    const fullPath = buildEntryPath(entry.path, prefix, entry.mode);
    yield buildEntryHeader(entry, fullPath, mtime, umask, uname, gname);
    byteCount += BLOCK_SIZE;

    if (hasDataBlock(entry.mode) && entry.content !== undefined && entry.content.length > 0) {
      const data = padTo512(entry.content);
      yield data;
      byteCount += data.length;
    }
  }

  // EOF: two 512-byte zero blocks
  yield new Uint8Array(BLOCK_SIZE * 2);
  byteCount += BLOCK_SIZE * 2;

  // Pad to multiple of RECORD_SIZE (10240)
  const remainder = byteCount % RECORD_SIZE;
  if (remainder !== 0) {
    yield new Uint8Array(RECORD_SIZE - remainder);
  }
}

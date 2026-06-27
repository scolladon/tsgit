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
import { FILE_MODE } from '../objects/file-mode.js';
import type { ArchiveEntry, ArchiveResult } from './types.js';

// Module-level TextEncoder instance; reuse to avoid repeated allocation.
const TEXT_ENCODER = new TextEncoder();

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

/** Maximum value that fits in `len-1` octal digits (e.g. 11 digits → 8^11-1). */
const MAX_OCTAL_VALUE = (len: number): number => 8 ** (len - 1) - 1;

/**
 * Write `val` as a zero-padded octal string of `len-1` digits followed by
 * a NUL byte into `buf` starting at `offset`.
 *
 * Throws if `val` exceeds the `len-1`-digit octal range.  For the size field
 * (len=12) the maximum is 8^11-1 = 8 589 934 591 bytes (~8 GiB); values
 * above that would require a pax extended-header (out of scope for v1).
 */
function writeOctal(buf: Uint8Array, offset: number, len: number, val: number): void {
  if (val > MAX_OCTAL_VALUE(len)) {
    throw new Error(
      `Value ${val} exceeds the ${len - 1}-digit octal field capacity (max ${MAX_OCTAL_VALUE(len)})`,
    );
  }
  const str = val.toString(8).padStart(len - 1, '0');
  // equivalent-mutant: i<=len-1 writes str.charCodeAt(len-1)=NaN→0 to offset+len-1, same as the
  // explicit 0x00 write below; i<len+1 additionally writes NaN→0 to offset+len, already 0 (zero-init).
  for (let i = 0; i < len - 1; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
  // equivalent-mutant: offset+len+1 writes 0x00 two bytes past the field; buf is zero-initialized so
  // that position is already 0x00. The intended null at offset+len-1 is also already 0x00 (zero-init).
  buf[offset + len - 1] = 0x00;
}

/**
 * Write ASCII string `str` into `len` bytes at `offset`, null-padding the
 * remainder. Characters beyond `len` are silently truncated.
 */
function writeAscii(buf: Uint8Array, offset: number, len: number, str: string): void {
  // equivalent-mutant: Math.max(str.length,len)=len when callers ensure str.length≤len; extra
  // charCodeAt iterations return NaN→0, writing 0 to already-zero-initialized positions.
  const writeLen = Math.min(str.length, len);
  // equivalent-mutant: i<=writeLen writes charCodeAt(writeLen)=NaN→0 to an already-zero position.
  for (let i = 0; i < writeLen; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}

/** Write raw `bytes` into `len` bytes at `offset`, null-padding the remainder. */
function writeBytes(buf: Uint8Array, offset: number, len: number, bytes: Uint8Array): void {
  // equivalent-mutant: Math.max(bytes.length,len): subarray(0,n>length) clamps to length — same slice.
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
  // equivalent-mutant: i<=7 writes str.charCodeAt(7)=NaN→0 to OFF_CHKSUM+7; same as explicit write below.
  for (let i = 0; i < 7; i++) {
    header[OFF_CHKSUM + i] = str.charCodeAt(i);
  }
  header[OFF_CHKSUM + 7] = 0x00;
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

interface HeaderParams {
  readonly nameBytes: Uint8Array;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly typeflag: number;
  readonly linknameBytes: Uint8Array;
  readonly uname: string;
  readonly gname: string;
  readonly prefixBytes: Uint8Array;
}

function writeFixedFields(buf: Uint8Array, p: HeaderParams): void {
  writeBytes(buf, OFF_NAME, LEN_NAME, p.nameBytes);
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
  writeBytes(buf, OFF_PREFIX_FIELD, LEN_PREFIX_FIELD, p.prefixBytes);
}

function buildHeader(p: HeaderParams): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE); // zero-initialised
  writeFixedFields(buf, p);
  writeUstarFields(buf, p);
  writeChecksum(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Path splitting (byte-accurate UTF-8)
// ---------------------------------------------------------------------------

interface PathFields {
  readonly nameBytes: Uint8Array;
  readonly prefixBytes: Uint8Array;
}

/**
 * Split a UTF-8 encoded path into ustar `name` (≤100 bytes) and `prefix`
 * (≤155 bytes) fields.  All measurements are in **bytes**, not UTF-16 code
 * units, so non-ASCII characters (é = 0xC3 0xA9 in UTF-8 = 2 bytes) are
 * measured and written faithfully.
 *
 * Paths whose UTF-8 encoding is ≤100 bytes go entirely into `name`.
 * Paths 101–256 bytes are split at a 0x2F ('/') byte boundary.
 * Paths >256 bytes are out of scope (throws).
 */
function splitPath(filePath: string): PathFields {
  const pathBytes = TEXT_ENCODER.encode(filePath);
  const byteLen = pathBytes.length;

  if (byteLen <= NAME_MAX) {
    return { nameBytes: pathBytes, prefixBytes: new Uint8Array(0) };
  }
  if (byteLen > PATH_MAX_USTAR) {
    throw new Error(`Path too long for ustar archive (>${PATH_MAX_USTAR} bytes): ${filePath}`);
  }
  // Search from the latest valid split point toward the start.
  // Require a non-empty name (1 ≤ nameLen ≤ NAME_MAX) so a trailing slash on
  // a directory path is never used as the split point (git never emits an
  // empty name — it splits before the last component instead).
  // equivalent-mutant: byteLen+1 — Math.min(byteLen+1,PREFIX_MAX)=155 for byteLen≥154; for byteLen=155
  // the extra start at i=155 accesses undefined→not 0x2f, then falls to 154 — identical result.
  // equivalent-mutant: i>=0 — pathBytes[0] is never 0x2f for valid git filenames; extra iteration
  // at i=0 finds no match, result is unchanged.
  for (let i = Math.min(byteLen - 1, PREFIX_MAX); i > 0; i--) {
    const nameLen = byteLen - i - 1;
    if (pathBytes[i] === 0x2f && nameLen >= 1 && nameLen <= NAME_MAX) {
      return {
        nameBytes: pathBytes.subarray(i + 1),
        prefixBytes: pathBytes.subarray(0, i),
      };
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
    case FILE_MODE.REGULAR:
      return MODE_REGULAR_BASE & ~umask;
    case FILE_MODE.EXECUTABLE:
      // equivalent-mutant: removing this return causes EXECUTABLE to fall through to DIRECTORY,
      // which returns the identical value MODE_MASKED_BASE & ~umask.
      return MODE_MASKED_BASE & ~umask;
    case FILE_MODE.DIRECTORY:
      // equivalent-mutant: removing this return causes DIRECTORY to fall through to GITLINK,
      // which returns the identical value MODE_MASKED_BASE & ~umask.
      return MODE_MASKED_BASE & ~umask;
    case FILE_MODE.GITLINK:
      return MODE_MASKED_BASE & ~umask;
    case FILE_MODE.SYMLINK:
      return MODE_SYMLINK;
  }
}

/** Map a git mode to the ustar typeflag byte. */
function modeTypeflag(mode: ArchiveEntry['mode']): number {
  switch (mode) {
    case FILE_MODE.REGULAR:
    case FILE_MODE.EXECUTABLE:
      return TYPEFLAG_REGULAR;
    case FILE_MODE.SYMLINK:
      return TYPEFLAG_SYMLINK;
    case FILE_MODE.DIRECTORY:
    case FILE_MODE.GITLINK:
      return TYPEFLAG_DIR;
  }
}

/** True for modes that contribute a data block (regular and exec only). */
function hasDataBlock(mode: ArchiveEntry['mode']): boolean {
  return mode === FILE_MODE.REGULAR || mode === FILE_MODE.EXECUTABLE;
}

/** True for modes whose tar name must carry a trailing '/'. */
function needsTrailingSlash(mode: ArchiveEntry['mode']): boolean {
  return mode === FILE_MODE.DIRECTORY || mode === FILE_MODE.GITLINK;
}

// ---------------------------------------------------------------------------
// Data block padding (zero-copy)
// ---------------------------------------------------------------------------

/**
 * Compute the number of NUL-padding bytes needed to align `byteLen` to the
 * next multiple of 512.  Returns 0 when `byteLen` is already aligned.
 */
function paddingNeeded(byteLen: number): number {
  const rem = byteLen % BLOCK_SIZE;
  return rem === 0 ? 0 : BLOCK_SIZE - rem;
}

// ---------------------------------------------------------------------------
// PAX global header builders
// ---------------------------------------------------------------------------

function buildPaxHeader(mtime: number, uname: string, gname: string): Uint8Array {
  const { nameBytes, prefixBytes } = splitPath(PAX_GLOBAL_NAME);
  return buildHeader({
    nameBytes,
    mode: PAX_MODE,
    size: PAX_RECORD_SIZE,
    mtime,
    typeflag: TYPEFLAG_PAX_GLOBAL,
    linknameBytes: new Uint8Array(0),
    uname,
    gname,
    prefixBytes,
  });
}

function buildPaxData(oid: string): Uint8Array {
  const buf = new Uint8Array(BLOCK_SIZE);
  const record = `${PAX_RECORD_SIZE} comment=${oid}\n`;
  // equivalent-mutant: i<=record.length writes record.charCodeAt(record.length)=NaN→0 to
  // buf[record.length]; buf is zero-initialized so that position is already 0x00.
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
  const { nameBytes, prefixBytes } = splitPath(fullPath);
  const isSymlink = entry.mode === FILE_MODE.SYMLINK;
  const linknameBytes =
    isSymlink && entry.content !== undefined ? entry.content : new Uint8Array(0);
  if (linknameBytes.length > LEN_LINKNAME) {
    throw new Error(
      `Symlink target too long for ustar archive (>${LEN_LINKNAME} bytes): ${fullPath}`,
    );
  }
  const size = hasDataBlock(entry.mode) && entry.content !== undefined ? entry.content.length : 0;
  return buildHeader({
    nameBytes,
    mode: tarMode(entry.mode, umask),
    size,
    mtime,
    typeflag: modeTypeflag(entry.mode),
    linknameBytes,
    uname,
    gname,
    prefixBytes,
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
  const { nameBytes, prefixBytes } = splitPath(prefix);
  return buildHeader({
    nameBytes,
    mode: MODE_MASKED_BASE & ~umask,
    size: 0,
    mtime,
    typeflag: TYPEFLAG_DIR,
    linknameBytes: new Uint8Array(0),
    uname,
    gname,
    prefixBytes,
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

    // equivalent-mutant: `entry.content.length >= 0` or `true` — when content.length=0 we'd
    // yield new Uint8Array(0) (0 bytes) and paddingNeeded(0)=0 — byte-identical to skipping.
    if (hasDataBlock(entry.mode) && entry.content !== undefined && entry.content.length > 0) {
      yield entry.content;
      byteCount += entry.content.length;
      const pad = paddingNeeded(entry.content.length);
      // equivalent-mutant: `pad >= 0` or `true` — when pad=0 we'd yield new Uint8Array(0)
      // (0 bytes), which is a no-op — byte-identical to skipping.
      if (pad > 0) {
        yield new Uint8Array(pad);
        byteCount += pad;
      }
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

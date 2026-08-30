/**
 * Raw byte-cursor over a tree object's on-disk entries — walks
 * `<mode> <name>\0<oid>` records in place without allocating a `TreeEntry`
 * per entry or a parsed `Tree`.
 *
 * `TreeCursor` is a documented exception to the house immutable-by-default
 * rule (precedented in-tree by `walk-tree.ts`'s `Counter` and the commit
 * priority-queue heap): the struct never escapes its consumers (the raw
 * merge-join, the raw flatten). Every value that *does* escape — an
 * `ObjectId`, a `FileMode`, a decoded name — is a fresh immutable value
 * built by one of the `cursor*` emit helpers below.
 */
import { decode, indexOf } from './encoding.js';
import { invalidTreeEntry } from './error.js';
import { type FileMode, matchFileModeBytes } from './file-mode.js';
import type { HashConfig } from './hash-config.js';
import { ObjectId } from './object-id.js';
import { hasNonOctalByte } from './tree-entry-bytes.js';

const SPACE = 0x20;
const NUL = 0x00;
const OCTAL_ZERO = 0x30;
const VIRTUAL_SLASH = 0x2f;

export interface TreeCursor {
  readonly buf: Uint8Array;
  readonly digestLength: number;
  /** An entry begins with its mode — `offset` IS the mode start. */
  offset: number;
  modeEnd: number;
  nameStart: number;
  nameEnd: number;
  oidStart: number;
  isDir: boolean;
  done: boolean;
}

export function openTreeCursor(buf: Uint8Array, hash: HashConfig): TreeCursor {
  const cursor: TreeCursor = {
    buf,
    digestLength: hash.digestLength,
    offset: 0,
    modeEnd: 0,
    nameStart: 0,
    nameEnd: 0,
    oidStart: 0,
    isDir: false,
    done: buf.length === 0,
  };
  if (!cursor.done) scanEntryAt(cursor, 0);
  return cursor;
}

export function advanceCursor(c: TreeCursor): void {
  const next = c.oidStart + c.digestLength;
  if (next >= c.buf.length) {
    c.done = true;
    return;
  }
  scanEntryAt(c, next);
}

function scanEntryAt(c: TreeCursor, start: number): void {
  c.offset = start;
  scanMode(c, start);
  scanName(c);
  scanOid(c);
  c.isDir = computeIsDir(c.buf, c.offset, c.modeEnd);
}

function scanMode(c: TreeCursor, start: number): void {
  const modeEnd = indexOf(c.buf, SPACE, start);
  if (modeEnd === -1) throw invalidTreeEntry(start, 'missing space after mode');
  if (modeEnd === start || hasNonOctalByte(c.buf, start, modeEnd)) {
    throw invalidTreeEntry(start, 'malformed mode');
  }
  c.modeEnd = modeEnd;
}

function scanName(c: TreeCursor): void {
  const nameStart = c.modeEnd + 1;
  const nameEnd = indexOf(c.buf, NUL, nameStart);
  if (nameEnd === -1) throw invalidTreeEntry(c.offset, 'missing null after name');
  if (nameEnd === nameStart) throw invalidTreeEntry(c.offset, 'empty filename');
  c.nameStart = nameStart;
  c.nameEnd = nameEnd;
}

function scanOid(c: TreeCursor): void {
  const oidStart = c.nameEnd + 1;
  if (oidStart + c.digestLength > c.buf.length) {
    throw invalidTreeEntry(c.offset, 'truncated hash');
  }
  c.oidStart = oidStart;
}

// git's `S_ISDIR(mode)` is `(mode & 0o170000) === 0o40000`. The mask covers
// exactly two octal digit positions counted from the right of the mode
// field — 8^4 (masked with 7, so that digit must equal 4) and 8^5 (masked
// with 1, so that digit must be even) — every higher digit is masked away,
// so arbitrarily long modes need no special case and no leading-zero strip.
function computeIsDir(buf: Uint8Array, modeStart: number, modeEnd: number): boolean {
  const length = modeEnd - modeStart;
  if (length < 5 || buf[modeEnd - 5] !== 0x34) return false;
  if (length === 5) return true;
  const pow5Byte = buf[modeEnd - 6]!;
  // Stryker disable next-line ArithmeticOperator: equivalent — OCTAL_ZERO (0x30) is
  // even, so adding or subtracting it preserves the byte's parity: `(byte +
  // OCTAL_ZERO) % 2` equals `(byte - OCTAL_ZERO) % 2` for every octal-digit byte,
  // leaving the directory verdict unchanged.
  const pow5Digit = pow5Byte - OCTAL_ZERO;
  return pow5Digit % 2 === 0;
}

/**
 * Byte-compare two entry names in git's tree sort order — a directory sorts
 * as if its name carried a trailing `/`. Hottest loop in the raw merge-join:
 * `buf`/`nameStart`/name-length are hoisted to locals once per side rather
 * than re-read off the cursor per byte, and the virtual-trailing-slash
 * lookup is inlined rather than a per-byte helper call.
 */
export function compareCursorNames(a: TreeCursor, b: TreeCursor): number {
  const aBuf = a.buf;
  const aStart = a.nameStart;
  const aRealLen = a.nameEnd - aStart;
  const aLen = aRealLen + (a.isDir ? 1 : 0);
  const bBuf = b.buf;
  const bStart = b.nameStart;
  const bRealLen = b.nameEnd - bStart;
  const bLen = bRealLen + (b.isDir ? 1 : 0);
  const end = Math.min(aLen, bLen);
  for (let i = 0; i < end; i++) {
    const av = i < aRealLen ? aBuf[aStart + i]! : VIRTUAL_SLASH;
    const bv = i < bRealLen ? bBuf[bStart + i]! : VIRTUAL_SLASH;
    const diff = av - bv;
    if (diff !== 0) return diff;
  }
  return aLen - bLen;
}

/**
 * Byte-equality check between a cursor's (undecoded) name and an
 * already-encoded target — the exact-match counterpart to
 * `compareCursorNames`, which orders two cursors against each other. No
 * virtual trailing slash: an exact name match never needs one.
 */
export function cursorNameEquals(c: TreeCursor, target: Uint8Array): boolean {
  const length = c.nameEnd - c.nameStart;
  if (length !== target.length) return false;
  for (let i = 0; i < length; i++) {
    if (c.buf[c.nameStart + i] !== target[i]) return false;
  }
  return true;
}

export function cursorsSame(a: TreeCursor, b: TreeCursor): boolean {
  return sameOid(a, b) && sameMode(a, b);
}

function sameOid(a: TreeCursor, b: TreeCursor): boolean {
  for (let i = 0; i < a.digestLength; i++) {
    if (a.buf[a.oidStart + i] !== b.buf[b.oidStart + i]) return false;
  }
  return true;
}

function sameMode(a: TreeCursor, b: TreeCursor): boolean {
  const aStart = skipLeadingZeros(a.buf, a.offset, a.modeEnd);
  const bStart = skipLeadingZeros(b.buf, b.offset, b.modeEnd);
  const aLength = a.modeEnd - aStart;
  const bLength = b.modeEnd - bStart;
  if (aLength !== bLength) return false;
  for (let i = 0; i < aLength; i++) {
    if (a.buf[aStart + i] !== b.buf[bStart + i]) return false;
  }
  return true;
}

// Leaves at least one digit — a mode field is never empty by the time
// `sameMode` runs (structural scanning already refused that).
function skipLeadingZeros(buf: Uint8Array, start: number, end: number): number {
  let i = start;
  // Stryker disable next-line ArithmeticOperator: equivalent — buf[end] is always
  // the mode's trailing space (0x20), never an octal digit, so the loop already
  // halts at i===end regardless of this bound; relaxing `end - 1` to `end + 1`
  // only ever lets i reach `end` (never beyond, since buf[end] can't match
  // OCTAL_ZERO) — same as the unmutated bound in every case.
  while (i < end - 1 && buf[i] === OCTAL_ZERO) i++;
  return i;
}

export function cursorName(c: TreeCursor): string {
  return decode(c.buf.subarray(c.nameStart, c.nameEnd));
}

export function cursorOid(c: TreeCursor): ObjectId {
  return ObjectId.fromRaw(c.buf.subarray(c.oidStart, c.oidStart + c.digestLength));
}

export function cursorMode(c: TreeCursor): FileMode {
  return matchFileModeBytes(c.buf, c.offset, c.modeEnd);
}

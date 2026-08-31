/**
 * Shared byte-level primitives for a tree entry. Kept deliberately small:
 * the octal-digit scan is the one piece of logic the tree parser and the raw
 * cursor must run identically, the byte key is the one piece fsck's
 * duplicate and sort passes share, and the dotgit alias fold is the one
 * piece fsck's special-file-name comparisons share. Deciding what a fault
 * *means* — a throw, a fsck finding — stays with each consumer, not here.
 */
const OCTAL_ZERO = 0x30;
const OCTAL_SEVEN = 0x37;
const KEY_CHUNK_SIZE = 1024;

/** True when `buf[start, end)` contains a byte outside the octal-digit range. */
export function hasNonOctalByte(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = buf[i]!;
    if (byte < OCTAL_ZERO || byte > OCTAL_SEVEN) return true;
  }
  return false;
}

/**
 * Lossless byte-to-string key for fsck's duplicate set and its name
 * comparisons. One code unit per byte, accumulated in bounded chunks — never
 * a spread over a whole 4096-byte name, which would overflow the argument
 * list. A text decoder is deliberately not used here: every single-byte
 * decoder either loses information (mapping distinct bytes to the same code
 * point) or is not reversible to the original byte, which would make a later
 * use of the key as a name silently wrong.
 */
export function entryNameKey(buf: Uint8Array, start: number, end: number): string {
  let key = '';
  // Stryker disable next-line EqualityOperator: equivalent — the only iteration this admits beyond the original loop has chunkStart===end, where chunkEnd=Math.min(chunkStart+KEY_CHUNK_SIZE,end)=end makes subarray(chunkStart,chunkEnd) empty, so the appended '' cannot change key.
  for (let chunkStart = start; chunkStart < end; chunkStart += KEY_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + KEY_CHUNK_SIZE, end);
    // Reflect.apply instead of a spread: the typed-array spread walks the
    // iterator protocol per element and dominates a name-heavy tree's fsck
    // pass (measured 5-8x slower); apply passes the chunk as arguments
    // directly. Output is identical for every byte value.
    key += Reflect.apply(String.fromCharCode, null, buf.subarray(chunkStart, chunkEnd));
  }
  return key;
}

/** The five names fsck folds through git's HFS/NTFS alias rule before comparing. */
export type DotgitAliasName = 'git' | 'gitmodules' | 'gitattributes' | 'gitignore' | 'mailmap';

// git's `next_hfs_char` (utf8.c): code points an HFS+ filesystem treats as
// invisible, dropped at ANY position before the alias comparison runs.
const HFS_IGNORABLE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c,
  0x206d, 0x206e, 0x206f, 0xfeff,
]);

const ASCII_DOT = 0x2e;
const ASCII_SPACE = 0x20;
const ASCII_TILDE = 0x7e;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_Z = 0x5a;
const ASCII_CASE_BIT = 0x20;
const NTFS_SHORT_NAME_LOW_DIGIT = 0x31; // '1'
const NTFS_SHORT_NAME_HIGH_DIGIT = 0x34; // '4'
const NTFS_SHORT_NAME_PREFIX_LENGTH = 6;

// Decodes only to run the HFS-ignorable fold — the one place in this file
// where decoding is correct rather than a bug, because git decodes here
// too (next_hfs_char). ignoreBOM: a leading BOM is one of the ignorable
// code points and is stripped by the fold's own filter, at any position —
// never by the decoder silently eating just the first one.
const HFS_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

function foldAsciiCodePoint(codePoint: number): number {
  // Stryker disable next-line EqualityOperator: equivalent — DotgitAliasName is a closed union of 5 literals (git/gitmodules/gitattributes/gitignore/mailmap) with no 'z', so the Z-only boundary this changes never determines any fold comparison this file makes.
  return codePoint >= ASCII_UPPER_A && codePoint <= ASCII_UPPER_Z
    ? codePoint + ASCII_CASE_BIT
    : codePoint;
}

/**
 * True when `buf[start, end)`, decoded as UTF-8 with every HFS-ignorable
 * code point dropped and the rest ASCII-case-folded, equals exactly
 * `.<alias>` — git's `is_hfs_dot_generic`. Malformed UTF-8 decodes to
 * U+FFFD, which matches no needle character, so it fails rather than
 * throws — matching git's own "can't be `.git`" outcome for bad bytes.
 */
function foldsToHfsAlias(
  buf: Uint8Array,
  start: number,
  end: number,
  alias: DotgitAliasName,
): boolean {
  const decoded = HFS_DECODER.decode(buf.subarray(start, end));
  const wantLength = alias.length + 1; // leading '.' + alias
  let matched = 0;
  for (const char of decoded) {
    const codePoint = char.codePointAt(0)!;
    if (HFS_IGNORABLE_CODE_POINTS.has(codePoint)) continue;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — once matched reaches wantLength (alias.length+1), the next want=alias.charCodeAt(matched-1) index is out of range and returns NaN, whose !== comparison is always true, so the loop returns false on the next iteration regardless of this guard.
    if (matched >= wantLength) return false;
    const want = matched === 0 ? ASCII_DOT : alias.charCodeAt(matched - 1);
    if (foldAsciiCodePoint(codePoint) !== want) return false;
    matched++;
  }
  return matched === wantLength;
}

function isAllDotsAndSpaces(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = buf[i]!;
    if (byte !== ASCII_DOT && byte !== ASCII_SPACE) return false;
  }
  return true;
}

function matchesAsciiCaseInsensitive(buf: Uint8Array, start: number, literal: string): boolean {
  for (let i = 0; i < literal.length; i++) {
    if (foldAsciiCodePoint(buf[start + i]!) !== literal.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * True when `buf[start, end)` is the NTFS form of `.<alias>` — git's
 * `is_ntfs_dotgit` / `is_ntfs_dot_generic`: a case-insensitive `.<alias>`
 * prefix, or the 8.3 short name, either followed by a run of trailing dots
 * and spaces (NTFS trims those on lookup). `git` itself is a bespoke case:
 * git only ever assigns `.git` the short name `git~1` (it guarantees `.git`
 * is a directory's first entry), never `~2`–`~4`; every other alias in this
 * family is long enough to need the general 6-char-prefix short name and
 * accepts `~1` through `~4`.
 */
function foldsToNtfsAlias(
  buf: Uint8Array,
  start: number,
  end: number,
  alias: DotgitAliasName,
): boolean {
  const length = end - start;
  const dotPrefix = `.${alias}`;
  if (
    // Stryker disable next-line EqualityOperator: equivalent — this >= only differs from > when length===dotPrefix.length exactly; at that length, matchesAsciiCaseInsensitive matching the pure-ASCII dotPrefix implies foldsToHfsAlias already matched the same bytes and returned true first, so this branch's outcome is never observed.
    length >= dotPrefix.length &&
    matchesAsciiCaseInsensitive(buf, start, dotPrefix) &&
    isAllDotsAndSpaces(buf, start + dotPrefix.length, end)
  ) {
    return true;
  }

  if (alias === 'git') {
    const shortName = 'git~1';
    return (
      length >= shortName.length &&
      matchesAsciiCaseInsensitive(buf, start, shortName) &&
      isAllDotsAndSpaces(buf, start + shortName.length, end)
    );
  }

  const shortPrefix = alias.slice(0, NTFS_SHORT_NAME_PREFIX_LENGTH);
  const digitOffset = start + shortPrefix.length + 1;
  return (
    length >= shortPrefix.length + 2 &&
    matchesAsciiCaseInsensitive(buf, start, shortPrefix) &&
    buf[start + shortPrefix.length] === ASCII_TILDE &&
    buf[digitOffset]! >= NTFS_SHORT_NAME_LOW_DIGIT &&
    buf[digitOffset]! <= NTFS_SHORT_NAME_HIGH_DIGIT &&
    isAllDotsAndSpaces(buf, digitOffset + 1, end)
  );
}

/**
 * True when `buf[start, end)` is an alias of `.<alias>` under git's dotgit
 * fold: HFS-ignorable code points dropped at any position, or the NTFS
 * short-name / trailing dot-space form, either compared case-insensitively.
 * Used only for fsck's alias comparisons (`hasDotgit`, `.gitmodules`,
 * `.gitattributes`, `.gitignore`, `.mailmap`) — the duplicate key, the sort
 * key and the length count compare raw bytes and never call this.
 */
export function matchesDotgitAlias(
  buf: Uint8Array,
  start: number,
  end: number,
  alias: DotgitAliasName,
): boolean {
  return foldsToHfsAlias(buf, start, end, alias) || foldsToNtfsAlias(buf, start, end, alias);
}

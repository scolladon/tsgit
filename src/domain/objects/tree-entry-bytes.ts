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

const ASCII_COLON = 0x3a;
const ASCII_SLASH = 0x2f;
const ASCII_BACKSLASH = 0x5c;
const ASCII_ZERO = 0x30;
const ASCII_ONE = 0x31;
const ASCII_NINE = 0x39;

/**
 * git's `only_spaces_and_periods`: the rest of the name is dots and spaces,
 * up to its end or an NTFS alternate-data-stream `:`. `.git` alone also stops
 * at a directory separator, as git's `is_ntfs_dotgit` does.
 */
function isNtfsTail(buf: Uint8Array, start: number, end: number, alias: DotgitAliasName): boolean {
  for (let i = start; i < end; i++) {
    const byte = buf[i]!;
    if (byte === ASCII_COLON) return true;
    if (alias === 'git' && (byte === ASCII_SLASH || byte === ASCII_BACKSLASH)) return true;
    if (byte !== ASCII_DOT && byte !== ASCII_SPACE) return false;
  }
  return true;
}

const isDigitIn = (byte: number | undefined, low: number): boolean =>
  byte !== undefined && byte >= low && byte <= ASCII_NINE;

function matchesAsciiCaseInsensitive(buf: Uint8Array, start: number, literal: string): boolean {
  for (let i = 0; i < literal.length; i++) {
    if (foldAsciiCodePoint(buf[start + i]!) !== literal.charCodeAt(i)) return false;
  }
  return true;
}

/** git's per-alias prefix for the 8.3 fall-back short name NTFS derives from a hash. */
const NTFS_FALLBACK_SHORT_NAME_PREFIX: Readonly<Record<Exclude<DotgitAliasName, 'git'>, string>> = {
  gitmodules: 'gi7eba',
  gitattributes: 'gi7d29',
  gitignore: 'gi250a',
  mailmap: 'maba30',
};

const NTFS_FALLBACK_SHORT_NAME_LENGTH = 8;

/**
 * git's fall-back NTFS short name: up to six leading characters of the
 * alias's hash prefix, `~`, a digit 1-9, then digits filling eight
 * characters, followed by the usual dot/space tail.
 */
function foldsToNtfsFallbackShortName(
  buf: Uint8Array,
  start: number,
  end: number,
  alias: Exclude<DotgitAliasName, 'git'>,
): boolean {
  const shortEnd = start + NTFS_FALLBACK_SHORT_NAME_LENGTH;
  if (end < shortEnd) return false;
  const head = buf.subarray(start, start + NTFS_SHORT_NAME_PREFIX_LENGTH + 1);
  const tilde = head.indexOf(ASCII_TILDE);
  // Stryker disable next-line ConditionalExpression: equivalent — with no tilde the prefix check would cover the first five prefix letters, and the digit check then reads that leading letter and fails
  if (tilde < 0) return false;
  if (
    !matchesAsciiCaseInsensitive(buf, start, NTFS_FALLBACK_SHORT_NAME_PREFIX[alias].slice(0, tilde))
  ) {
    return false;
  }
  if (!isDigitIn(buf[start + tilde + 1], ASCII_ONE)) return false;
  for (let i = start + tilde + 2; i < shortEnd; i++)
    if (!isDigitIn(buf[i], ASCII_ZERO)) return false;
  return isNtfsTail(buf, shortEnd, end, alias);
}

/**
 * The 8.3 short name NTFS gives `.<alias>`: `git~1` for `.git` (git
 * guarantees `.git` is a directory's first entry), and for every other alias
 * its first six characters with `~1`..`~4`, or the hash-derived fall-back.
 */
function foldsToNtfsShortName(
  buf: Uint8Array,
  start: number,
  end: number,
  alias: DotgitAliasName,
): boolean {
  if (alias === 'git') {
    const shortName = 'git~1';
    return (
      end - start >= shortName.length &&
      matchesAsciiCaseInsensitive(buf, start, shortName) &&
      isNtfsTail(buf, start + shortName.length, end, alias)
    );
  }
  const shortPrefix = alias.slice(0, NTFS_SHORT_NAME_PREFIX_LENGTH);
  const digitOffset = start + shortPrefix.length + 1;
  const regular =
    end - start >= shortPrefix.length + 2 &&
    matchesAsciiCaseInsensitive(buf, start, shortPrefix) &&
    buf[start + shortPrefix.length] === ASCII_TILDE &&
    buf[digitOffset]! >= NTFS_SHORT_NAME_LOW_DIGIT &&
    buf[digitOffset]! <= NTFS_SHORT_NAME_HIGH_DIGIT &&
    isNtfsTail(buf, digitOffset + 1, end, alias);
  return regular || foldsToNtfsFallbackShortName(buf, start, end, alias);
}

/**
 * True when `buf[start, end)` is the NTFS form of `.<alias>` — git's
 * `is_ntfs_dotgit` / `is_ntfs_dot_generic`: a case-insensitive `.<alias>`
 * or its 8.3 short name, followed by a run of dots and spaces (NTFS trims
 * those on lookup) that may end at an alternate-data-stream `:`.
 */
export function matchesNtfsDotgitAlias(
  buf: Uint8Array,
  start: number,
  end: number,
  alias: DotgitAliasName,
): boolean {
  const dotPrefix = `.${alias}`;
  if (
    end - start >= dotPrefix.length &&
    matchesAsciiCaseInsensitive(buf, start, dotPrefix) &&
    isNtfsTail(buf, start + dotPrefix.length, end, alias)
  ) {
    return true;
  }
  return foldsToNtfsShortName(buf, start, end, alias);
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
  return foldsToHfsAlias(buf, start, end, alias) || matchesNtfsDotgitAlias(buf, start, end, alias);
}

/**
 * The start of every segment that follows a backslash in `buf[start, end)`,
 * each running to the name's end — git's `fsck_tree` re-checks those as NTFS
 * paths, since Windows reads a backslash as a directory separator.
 */
export function backslashSegmentStarts(
  buf: Uint8Array,
  start: number,
  end: number,
): ReadonlyArray<number> {
  const starts: number[] = [];
  for (let i = start; i < end; i++) if (buf[i] === ASCII_BACKSLASH) starts.push(i + 1);
  return starts;
}

/** Whether the name is `.gitmodules` to git's `fsck_tree`: the whole name under
 *  either fold, or any backslash segment under the NTFS one. */
export function namesGitmodules(buf: Uint8Array, start: number, end: number): boolean {
  if (matchesDotgitAlias(buf, start, end, 'gitmodules')) return true;
  return backslashSegmentStarts(buf, start, end).some((segment) =>
    matchesNtfsDotgitAlias(buf, segment, end, 'gitmodules'),
  );
}

/**
 * The ref-glob dialect `gc.<pattern>.*` and `name-rev`'s `--refs`/`--exclude`
 * share: git's `wildmatch(pattern, ref, 0)` — `*` and `?` cross `/` (no
 * `WM_PATHNAME`), `\x` escapes one byte, and `[…]` is a POSIX bracket
 * expression. The `WM_PATHNAME` variant (`merge.suppressDest`) keeps `*`, `?`
 * and `[…]` inside one `/`-separated segment and lets only a whole-segment
 * `**` cross it. Matched over UTF-8 bytes, not UTF-16 code units, because
 * `wildmatch` itself compares raw bytes.
 *
 * Compiled to a LINEAR, non-backtracking matcher: the pattern is tokenised
 * once, then matched with a backward dynamic program filling a boolean table
 * in `O(tokenCount × textLength)` — the same shape as `compileGlob`
 * (`../pathspec/compile-glob.ts`). No pattern, adversarial included, can make
 * this super-linear; a bracket-heavy or star-heavy pattern from repository
 * configuration must never open a ReDoS class the way a backtracking
 * `RegExp` would.
 *
 * A pattern git's own `dowild` would abort on — an unterminated `[`, a
 * trailing unescaped `\`, or an unrecognised `[:class:]` name — compiles to a
 * matcher that accepts nothing, for any input: those are exactly the
 * `WM_ABORT_ALL` cases, and `WM_ABORT_ALL` propagates through every
 * recursive alignment `dowild` tries, so no text can ever make the pattern
 * succeed.
 */
import { decode, encode } from '../objects/encoding.js';

const STAR = 0x2a; // *
const QUESTION = 0x3f; // ?
const BACKSLASH = 0x5c; // \
const LBRACKET = 0x5b; // [
const RBRACKET = 0x5d; // ]
const BANG = 0x21; // !
const CARET = 0x5e; // ^
const COLON = 0x3a; // :
const DASH = 0x2d; // -
const SLASH = 0x2f; // /

type ByteTest = (byte: number) => boolean;

/**
 * `star` — any run of bytes, `/` included; `segment` — any run without `/`
 * (a WM_PATHNAME `*`); `dirs` — a WM_PATHNAME `**` + `/`: zero or more whole
 * `<segment>/` runs; `match` — one byte its test admits.
 */
type RefGlobToken =
  | { readonly kind: 'star' }
  | { readonly kind: 'segment' }
  | { readonly kind: 'dirs' }
  | { readonly kind: 'match'; readonly test: ByteTest };

const CROSSING_STAR: RefGlobToken = { kind: 'star' };
const SEGMENT_STAR: RefGlobToken = { kind: 'segment' };
const DIRS: RefGlobToken = { kind: 'dirs' };

/** One `[…]` member: a single byte, an inclusive byte range, or a POSIX class. */
type BracketAtom =
  | { readonly kind: 'byte'; readonly value: number }
  | { readonly kind: 'range'; readonly lo: number; readonly hi: number }
  | { readonly kind: 'class'; readonly test: ByteTest };

const isAlpha = (b: number): boolean => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39;
// git's own `isspace` (`sane_ctype`), not the C library's: vertical tab and form
// feed are not spaces.
const isSpace = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const isPrint = (b: number): boolean => b >= 0x20 && b < 0x7f;
const isGraph = (b: number): boolean => isPrint(b) && b !== 0x20;

/** git's `ISALNUM`/`ISALPHA`/… — the twelve `[:class:]` names `dowild`
 *  recognises, restricted to the C-locale ASCII range (bytes ≥ 0x80 never
 *  classify, matching a scrubbed, locale-less environment). */
const CLASS_TESTS: Readonly<Record<string, ByteTest>> = {
  alnum: (b) => isAlpha(b) || isDigit(b),
  alpha: isAlpha,
  blank: (b) => b === 0x20 || b === 0x09,
  cntrl: (b) => b < 0x20 || b === 0x7f,
  digit: isDigit,
  graph: isGraph,
  lower: (b) => b >= 0x61 && b <= 0x7a,
  print: isPrint,
  punct: (b) => isGraph(b) && !isAlpha(b) && !isDigit(b),
  space: isSpace,
  upper: (b) => b >= 0x41 && b <= 0x5a,
  xdigit: (b) => isDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66),
};

const bracketTest = (negated: boolean, atoms: ReadonlyArray<BracketAtom>): ByteTest => {
  const matchesAtom = (atom: BracketAtom, byte: number): boolean => {
    if (atom.kind === 'byte') return byte === atom.value;
    // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. every range is preceded in the same set by the byte member that seeded its `lo` (git's `prev_ch`), so `byte === atom.lo` is already admitted by that member and this bound is unobservable.
    if (atom.kind === 'range') return byte >= atom.lo && byte <= atom.hi;
    return atom.test(byte);
  };
  return (byte: number): boolean => negated !== atoms.some((atom) => matchesAtom(atom, byte));
};

/** Parse one `[…]` member starting at `bytes[i]`, `i` past any negation
 *  marker. Returns the atom, the next index, and whether this member's
 *  value can seed a `lo-hi` range on a later `-` (git's `prev_ch`) — a range
 *  or class resets it to "no previous member" (git sets `p_ch = 0`). */
interface MemberResult {
  readonly atom: BracketAtom;
  readonly next: number;
  readonly rangeSeed: number | undefined;
}

const parseClassAttempt = (bytes: Uint8Array, i: number): MemberResult | undefined => {
  let j = i + 2;
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. `j` can only walk up to `bytes.length`, and the refusal below rejects both that and the `bytes.length + 1` this mutant reaches instead.
  while (j < bytes.length && bytes[j] !== RBRACKET) j += 1;
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. the scan above stops at `j === bytes.length`, so a strict bound never fires and leaves the same abort the proof below describes.
  // Stryker disable next-line ConditionalExpression: equivalent — `j === bytes.length` means no `]` exists at or after `i + 2` and `bytes[i + 1]` is `:`, so the caller's own scan also runs off the end and aborts; dropping this early refusal only moves where `undefined` comes from.
  if (j >= bytes.length) return undefined; // unterminated — caller aborts
  const nameLength = j - i - 3;
  if (nameLength < 0 || bytes[j - 1] !== COLON) {
    // No real "name:]" found — the leading '[' is an ordinary member; resume
    // scanning right after it (git's `p = s - 2` rewind then `next:`).
    return { atom: { kind: 'byte', value: LBRACKET }, next: i + 1, rangeSeed: LBRACKET };
  }
  const name = decode(bytes.subarray(i + 2, j - 1));
  const test = CLASS_TESTS[name];
  if (test === undefined) return undefined; // unknown class name — abort
  return { atom: { kind: 'class', test }, next: j + 1, rangeSeed: undefined };
};

const parseMember = (
  bytes: Uint8Array,
  i: number,
  prevSeed: number | undefined,
): MemberResult | undefined => {
  const byte = bytes[i] as number;
  if (byte === BACKSLASH) {
    const escaped = bytes[i + 1];
    if (escaped === undefined) return undefined; // trailing '\' in a set — abort
    return { atom: { kind: 'byte', value: escaped }, next: i + 2, rangeSeed: escaped };
  }
  if (
    byte === DASH &&
    prevSeed !== undefined &&
    // Stryker disable next-line ArithmeticOperator,ConditionalExpression: equivalent — `i` always sits past the opening `[`, so `bytes[i - 1]` is defined and both mutants hold this conjunct constantly true; it only ever differs when `-` is the pattern's last byte, and that set is unterminated, so the caller aborts either way.
    bytes[i + 1] !== undefined &&
    bytes[i + 1] !== RBRACKET
  ) {
    let hi = bytes[i + 1] as number;
    let next = i + 2;
    if (hi === BACKSLASH) {
      const escaped = bytes[i + 2];
      if (escaped === undefined) return undefined; // trailing '\' as a range bound — abort
      hi = escaped;
      next = i + 3;
    }
    return { atom: { kind: 'range', lo: prevSeed, hi }, next, rangeSeed: undefined };
  }
  if (byte === LBRACKET && bytes[i + 1] === COLON) return parseClassAttempt(bytes, i);
  return { atom: { kind: 'byte', value: byte }, next: i + 1, rangeSeed: byte };
};

/** Parse a `[…]` bracket expression starting at the `[` (`bytes[open]`).
 *  Returns the compiled token and the index past the closing `]`, or
 *  `undefined` when the set is unterminated or names an unknown class —
 *  both of which make the WHOLE pattern match nothing (see module docs). */
const parseBracket = (
  bytes: Uint8Array,
  open: number,
  dialect: Dialect,
): { readonly token: RefGlobToken; readonly next: number } | undefined => {
  let i = open + 1;
  let negated = false;
  if (bytes[i] === BANG || bytes[i] === CARET) {
    negated = true;
    i += 1;
  }
  const atoms: BracketAtom[] = [];
  let rangeSeed: number | undefined;
  let first = true;
  for (;;) {
    // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. a member's `next` never overshoots `bytes.length`, so at `i === bytes.length` the mutant parses one member off the end, lands on `bytes.length + 1` and refuses on the following turn; the caller still sees `undefined`.
    if (i >= bytes.length) return undefined; // ran off the end — unterminated
    if (!first && bytes[i] === RBRACKET) {
      i += 1;
      break;
    }
    first = false;
    const member = parseMember(bytes, i, rangeSeed);
    if (member === undefined) return undefined;
    atoms.push(member.atom);
    rangeSeed = member.rangeSeed;
    i = member.next;
  }
  return { token: { kind: 'match', test: dialect.single(bracketTest(negated, atoms)) }, next: i };
};

interface ScannedToken {
  readonly token: RefGlobToken;
  readonly next: number;
}

/** What the `wildmatch` flags change: how a `*` run tokenises, and whether a
 *  one-byte matcher (`?`, `[…]`) may match `/`. */
interface Dialect {
  readonly starRun: (bytes: Uint8Array, start: number, end: number) => ScannedToken;
  readonly single: (test: ByteTest) => ByteTest;
}

/** flags 0: every `*` run is one `star`, and a one-byte matcher admits `/`. */
const REF_DIALECT: Dialect = {
  starRun: (_bytes, _start, end) => ({ token: CROSSING_STAR, next: end }),
  single: (test) => test,
};

/** `dowild`'s WM_PATHNAME `**`: two or more stars standing alone between
 *  slashes (or the pattern's ends; `\/` counts as the slash after). */
const isWholeSegmentRun = (bytes: Uint8Array, start: number, end: number): boolean => {
  const before = start === 0 || bytes[start - 1] === SLASH;
  const after =
    end === bytes.length ||
    bytes[end] === SLASH ||
    (bytes[end] === BACKSLASH && bytes[end + 1] === SLASH);
  return end - start > 1 && before && after;
};

/** WM_PATHNAME: a lone or embedded `*` run stays in its segment; a whole-segment
 *  `**` crosses `/`, and before a `/` also matches no directory at all. */
const pathnameStarRun = (bytes: Uint8Array, start: number, end: number): ScannedToken => {
  if (!isWholeSegmentRun(bytes, start, end)) return { token: SEGMENT_STAR, next: end };
  if (bytes[end] === SLASH) return { token: DIRS, next: end + 1 };
  return { token: CROSSING_STAR, next: end };
};

const PATHNAME_DIALECT: Dialect = {
  starRun: pathnameStarRun,
  single: (test) => (byte) => byte !== SLASH && test(byte),
};

// A run of one or more consecutive `*` — scanned whole, then tokenised by the
// dialect: under flags 0 every count behaves identically (any run of bytes,
// slashes included), so the whole run collapses into a single `star` token.
const scanStarRun = (bytes: Uint8Array, i: number, dialect: Dialect): ScannedToken => {
  let next = i + 1;
  while (bytes[next] === STAR) next += 1;
  return dialect.starRun(bytes, i, next);
};

// `\x` — a literal `x`; `undefined` when `\` is the pattern's last byte
// (nothing to escape), which never matches (see module docs).
const scanEscape = (bytes: Uint8Array, i: number): ScannedToken | undefined => {
  const escaped = bytes[i + 1];
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. without this refusal the token tests `b === undefined`, which no byte satisfies, so the compiled matcher rejects every ref exactly as the `() => false` this abort produces.
  if (escaped === undefined) return undefined;
  return { token: { kind: 'match', test: (b) => b === escaped }, next: i + 2 };
};

const scanToken = (bytes: Uint8Array, i: number, dialect: Dialect): ScannedToken | undefined => {
  const byte = bytes[i] as number;
  if (byte === STAR) return scanStarRun(bytes, i, dialect);
  if (byte === QUESTION) {
    return { token: { kind: 'match', test: dialect.single(() => true) }, next: i + 1 };
  }
  if (byte === BACKSLASH) return scanEscape(bytes, i);
  if (byte === LBRACKET) return parseBracket(bytes, i, dialect);
  return { token: { kind: 'match', test: (b) => b === byte }, next: i + 1 };
};

/** Tokenise a pattern's UTF-8 bytes, or `undefined` when the pattern can
 *  never match anything (an unterminated `[`, an unknown `[:class:]` name,
 *  or a trailing unescaped `\`). */
const tokenize = (bytes: Uint8Array, dialect: Dialect): ReadonlyArray<RefGlobToken> | undefined => {
  const tokens: RefGlobToken[] = [];
  let i = 0;
  while (i < bytes.length) {
    const scanned = scanToken(bytes, i, dialect);
    if (scanned === undefined) return undefined;
    tokens.push(scanned.token);
    i = scanned.next;
  }
  return tokens;
};

// `star` matches zero or more of ANY byte — `wildmatch`'s `*`/`**` under
// flags 0, where a single `*` already crosses `/`.
const stepStar = (text: Uint8Array, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(text.length + 1);
  cur[text.length] = next[text.length] === 1 ? 1 : 0;
  // Stryker disable next-line ArithmeticOperator: equivalent — `cur` holds `text.length + 1` slots, so the extra turn writes past the end (a silent no-op on a typed array) and reads `undefined`; the turn at `text.length` then recomputes the value the line above already stored.
  for (let j = text.length - 1; j >= 0; j--) {
    cur[j] = next[j] === 1 || cur[j + 1] === 1 ? 1 : 0;
  }
  return cur;
};

// `segment` — `star` that stops at the first `/` it would have to consume.
const stepSegment = (text: Uint8Array, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(text.length + 1);
  cur[text.length] = next[text.length] === 1 ? 1 : 0;
  for (let j = text.length - 1; j >= 0; j--) {
    cur[j] = next[j] === 1 || (text[j] !== SLASH && cur[j + 1] === 1) ? 1 : 0;
  }
  return cur;
};

const isSlash: ByteTest = (byte) => byte === SLASH;

// `dirs` — nothing at all, or any run ending in a `/`.
const stepDirs = (text: Uint8Array, next: Uint8Array): Uint8Array => {
  const throughSlash = stepStar(text, stepMatch(isSlash, text, next));
  return throughSlash.map((cell, j) => (cell === 1 || next[j] === 1 ? 1 : 0));
};

const stepToken = (token: RefGlobToken, text: Uint8Array, next: Uint8Array): Uint8Array => {
  if (token.kind === 'star') return stepStar(text, next);
  if (token.kind === 'segment') return stepSegment(text, next);
  if (token.kind === 'dirs') return stepDirs(text, next);
  return stepMatch(token.test, text, next);
};

const stepMatch = (test: ByteTest, text: Uint8Array, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(text.length + 1);
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. the extra turn reads `next[text.length + 1]` past the end, which is never `1`, so no cell is written whatever `test` answers for the undefined byte beyond the text.
  for (let j = 0; j < text.length; j++) {
    if (test(text[j] as number) && next[j + 1] === 1) cur[j] = 1;
  }
  return cur;
};

const matchTokens = (tokens: ReadonlyArray<RefGlobToken>, text: Uint8Array): boolean => {
  let dp: Uint8Array = new Uint8Array(text.length + 1);
  dp[text.length] = 1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    dp = stepToken(tokens[i] as RefGlobToken, text, dp);
  }
  return dp[0] === 1;
};

const compileWith = (pattern: string, dialect: Dialect): ((text: string) => boolean) => {
  const tokens = tokenize(encode(pattern), dialect);
  if (tokens === undefined) return () => false;
  return (text: string): boolean => matchTokens(tokens, encode(text));
};

/** Compiles `pattern` once into a matcher `wildmatch(pattern, ref, 0)`
 *  agrees with byte-for-byte — full match, case-sensitive, `*`/`?` crossing
 *  `/`. Reuse the returned function across many refs instead of recompiling. */
export const compileRefGlob = (pattern: string): ((ref: string) => boolean) =>
  compileWith(pattern, REF_DIALECT);

/** Compiles `pattern` into a matcher `wildmatch(pattern, text, WM_PATHNAME)`
 *  agrees with — `*`, `?` and `[…]` stay within one `/`-separated segment,
 *  a whole-segment `**` crosses them (`merge.suppressDest`). */
export const compilePathnameGlob = (pattern: string): ((text: string) => boolean) =>
  compileWith(pattern, PATHNAME_DIALECT);

/** One-shot form of {@link compileRefGlob} for a single ref check. */
export const matchRefGlob = (pattern: string, ref: string): boolean => compileRefGlob(pattern)(ref);

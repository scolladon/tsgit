/**
 * git's `dowild` over UTF-8 bytes, shared by every glob dialect that wants
 * `wildmatch` semantics: `\x` escapes one byte, `[…]` is a POSIX bracket
 * expression, and `WM_PATHNAME` keeps `*`, `?` and `[…]` inside one
 * `/`-separated segment while a whole-segment `**` crosses it. Matched over
 * bytes, not UTF-16 code units, because `wildmatch` itself compares raw bytes.
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
 * trailing unescaped `\`, or an unrecognised `[:class:]` name — tokenises to
 * `undefined`, a matcher that accepts nothing, for any input: those are exactly
 * the `WM_ABORT_ALL` cases, and `WM_ABORT_ALL` propagates through every
 * recursive alignment `dowild` tries, so no text can ever make the pattern
 * succeed.
 */
import { decode } from '../objects/encoding.js';

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

const BYTE_VALUES = 256;

type ByteTest = (byte: number) => boolean;

/**
 * `star` — any run of bytes, `/` included; `segment` — any run without `/`
 * (a WM_PATHNAME `*`); `dirs` — a WM_PATHNAME `**` + `/`: zero or more whole
 * `<segment>/` runs; `byte` — exactly that byte; `set` — one byte whose entry
 * in the 256-slot `table` is 1 (`?` and `[…]`, `/` already excluded under
 * WM_PATHNAME).
 */
export type WildmatchToken =
  | { readonly kind: 'star' }
  | { readonly kind: 'segment' }
  | { readonly kind: 'dirs' }
  | { readonly kind: 'byte'; readonly value: number }
  | { readonly kind: 'set'; readonly table: Uint8Array };

const CROSSING_STAR: WildmatchToken = { kind: 'star' };
const SEGMENT_STAR: WildmatchToken = { kind: 'segment' };
export const LEADING_DIRECTORIES: WildmatchToken = { kind: 'dirs' };

/** One `[…]` member: a single byte, an inclusive byte range, or a POSIX class. */
type BracketAtom =
  | { readonly kind: 'byte'; readonly value: number }
  | { readonly kind: 'range'; readonly lo: number; readonly hi: number }
  | { readonly kind: 'class'; readonly test: ByteTest; readonly upper: boolean };

const isUpper = (b: number): boolean => b >= 0x41 && b <= 0x5a;
const isLower = (b: number): boolean => b >= 0x61 && b <= 0x7a;
const isAlpha = (b: number): boolean => isUpper(b) || isLower(b);
const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39;
// git's own `isspace` (`sane_ctype`), not the C library's: vertical tab and form
// feed are not spaces.
const isSpace = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const isPrint = (b: number): boolean => b >= 0x20 && b < 0x7f;
const isGraph = (b: number): boolean => isPrint(b) && b !== 0x20;

/** git's `ISALNUM`/`ISALPHA`/… — the twelve `[:class:]` names `dowild`
 *  recognises, restricted to the C-locale ASCII range (bytes ≥ 0x80 never
 *  classify, matching a scrubbed, locale-less environment). */
// A Map, not an object literal: class names come from repository-controlled
// patterns, and an inherited key such as `constructor` must not resolve.
const CLASS_TESTS: ReadonlyMap<string, ByteTest> = new Map([
  ['alnum', (b) => isAlpha(b) || isDigit(b)],
  ['alpha', isAlpha],
  ['blank', (b) => b === 0x20 || b === 0x09],
  ['cntrl', (b) => b < 0x20 || b === 0x7f],
  ['digit', isDigit],
  ['graph', isGraph],
  ['lower', isLower],
  ['print', isPrint],
  ['punct', (b) => isGraph(b) && !isAlpha(b) && !isDigit(b)],
  ['space', isSpace],
  ['upper', isUpper],
  ['xdigit', (b) => isDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)],
]);

const CASE_OFFSET = 0x20; // 'a' - 'A'

const inRange = (lo: number, hi: number, byte: number): boolean => byte >= lo && byte <= hi;

const markClass = (table: Uint8Array, test: ByteTest): void => {
  for (let x = 0; x < BYTE_VALUES; x++) if (test(x)) table[x] = 1;
};

// Under case folding the text arrives lowered, so a lower-case byte is admitted
// when its upper-case form lies in the range; the members themselves stay as written.
const markRange = (table: Uint8Array, lo: number, hi: number, caseFold: boolean): void => {
  for (let x = 0; x < BYTE_VALUES; x++) {
    const folded = caseFold && isLower(x) && inRange(lo, hi, x - CASE_OFFSET);
    if (inRange(lo, hi, x) || folded) table[x] = 1;
  }
};

const markAtom = (table: Uint8Array, atom: BracketAtom, caseFold: boolean): void => {
  if (atom.kind === 'byte') table[atom.value] = 1;
  else if (atom.kind === 'range') markRange(table, atom.lo, atom.hi, caseFold);
  else markClass(table, caseFold && atom.upper ? isAlpha : atom.test);
};

/** The 256-slot admit table of a bracket expression: every byte a member
 *  admits, flipped when negated, and never `/` under WM_PATHNAME. Cost is
 *  O(atoms + 256) at compile time; matching is one array read per byte. */
const buildSetTable = (
  atoms: ReadonlyArray<BracketAtom>,
  negated: boolean,
  flags: WildmatchFlags,
): Uint8Array => {
  const table = new Uint8Array(BYTE_VALUES);
  for (const atom of atoms) markAtom(table, atom, flags.caseFold);
  for (let x = 0; x < BYTE_VALUES; x++) {
    const admitted = (table[x] === 1) !== negated;
    table[x] = admitted && !(flags.pathname && x === SLASH) ? 1 : 0;
  }
  return table;
};

/** The set tokens of one compile, keyed by table content. A pattern may repeat a
 *  set as often as its length allows: it then holds one table, not one per use. */
type SetPool = Map<string, WildmatchToken>;

const pooledSet = (table: Uint8Array, pool: SetPool): WildmatchToken => {
  const key = String.fromCharCode(...table);
  const known = pool.get(key);
  if (known !== undefined) return known;
  const token: WildmatchToken = { kind: 'set', table };
  pool.set(key, token);
  return token;
};

// A set of one plain byte is that byte, with no table to hold. `/` under
// WM_PATHNAME stays a set: its table refuses the slash, a byte token would not.
const soleByteOf = (
  atoms: ReadonlyArray<BracketAtom>,
  negated: boolean,
  flags: WildmatchFlags,
): number | undefined => {
  if (negated || atoms.length !== 1) return undefined;
  const only = atoms[0] as BracketAtom;
  if (only.kind !== 'byte') return undefined;
  return flags.pathname && only.value === SLASH ? undefined : only.value;
};

const setToken = (
  atoms: ReadonlyArray<BracketAtom>,
  negated: boolean,
  compile: Compile,
): WildmatchToken => {
  const sole = soleByteOf(atoms, negated, compile.flags);
  if (sole !== undefined) return { kind: 'byte', value: sole };
  return pooledSet(buildSetTable(atoms, negated, compile.flags), compile.sets);
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

// `closeAfter[i + 2]` is the first `]` the name could end at; `n` (no `]`) falls
// into the branches below: a name ending in `:` still aborts or resolves, any
// other tail makes the `[` a plain member and the set aborts unterminated.
const parseClassAttempt = (
  bytes: Uint8Array,
  i: number,
  closeAfter: Int32Array,
): MemberResult | undefined => {
  const j = closeAfter[i + 2] as number;
  const nameLength = j - i - 3;
  if (nameLength < 0 || bytes[j - 1] !== COLON) {
    // No real "name:]" found — the leading '[' is an ordinary member; resume
    // scanning right after it (git's `p = s - 2` rewind then `next:`).
    return { atom: { kind: 'byte', value: LBRACKET }, next: i + 1, rangeSeed: LBRACKET };
  }
  const name = decode(bytes.subarray(i + 2, j - 1));
  const test = CLASS_TESTS.get(name);
  if (test === undefined) return undefined; // unknown class name — abort
  return {
    atom: { kind: 'class', test, upper: name === 'upper' },
    next: j + 1,
    rangeSeed: undefined,
  };
};

const parseMember = (
  bytes: Uint8Array,
  i: number,
  prevSeed: number | undefined,
  closeAfter: Int32Array,
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
  if (byte === LBRACKET && bytes[i + 1] === COLON) return parseClassAttempt(bytes, i, closeAfter);
  return { atom: { kind: 'byte', value: byte }, next: i + 1, rangeSeed: byte };
};

/** Parse a `[…]` bracket expression starting at the `[` (`bytes[open]`).
 *  Returns the compiled token and the index past the closing `]`, or
 *  `undefined` when the set is unterminated or names an unknown class —
 *  both of which make the WHOLE pattern match nothing (see module docs). */
const parseBracket = (
  compile: Compile,
  open: number,
): { readonly token: WildmatchToken; readonly next: number } | undefined => {
  const { bytes, closeAfter } = compile;
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
    // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. a member's `next` overshoots `bytes.length` by one at most, so at `i === bytes.length` the mutant parses one plain member off the end, lands on `bytes.length + 1` and refuses on the following turn; the caller still sees `undefined`.
    if (i >= bytes.length) return undefined; // ran off the end — unterminated
    if (!first && bytes[i] === RBRACKET) {
      i += 1;
      break;
    }
    first = false;
    const member = parseMember(bytes, i, rangeSeed, closeAfter);
    if (member === undefined) return undefined;
    atoms.push(member.atom);
    rangeSeed = member.rangeSeed;
    i = member.next;
  }
  return { token: setToken(atoms, negated, compile), next: i };
};

interface ScannedToken {
  readonly token: WildmatchToken;
  readonly next: number;
}

/** What the `wildmatch` flags change: how a `*` run tokenises, and whether a
 *  one-byte matcher (`?`, `[…]`) may match `/`. */
interface Dialect {
  readonly starRun: (bytes: Uint8Array, start: number, end: number) => ScannedToken;
  readonly anyByte: WildmatchToken;
}

/** What one compile shares across its scans. */
interface Compile {
  readonly bytes: Uint8Array;
  readonly closeAfter: Int32Array;
  readonly dialect: Dialect;
  readonly flags: WildmatchFlags;
  readonly sets: SetPool;
}

const REF_FLAGS: WildmatchFlags = { pathname: false, caseFold: false };
const PATHNAME_FLAGS: WildmatchFlags = { pathname: true, caseFold: false };

/** flags 0: every `*` run is one `star`, and a one-byte matcher admits `/`. */
const REF_DIALECT: Dialect = {
  starRun: (_bytes, _start, end) => ({ token: CROSSING_STAR, next: end }),
  anyByte: { kind: 'set', table: buildSetTable([], true, REF_FLAGS) },
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
  if (bytes[end] === SLASH) return { token: LEADING_DIRECTORIES, next: end + 1 };
  return { token: CROSSING_STAR, next: end };
};

const PATHNAME_DIALECT: Dialect = {
  starRun: pathnameStarRun,
  anyByte: { kind: 'set', table: buildSetTable([], true, PATHNAME_FLAGS) },
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
  return { token: { kind: 'byte', value: escaped }, next: i + 2 };
};

// Only the plain byte is lowered: `\x` and set members compare as written.
const foldPlain = (byte: number, flags: WildmatchFlags): number =>
  flags.caseFold && isUpper(byte) ? byte + CASE_OFFSET : byte;

const scanToken = (compile: Compile, i: number): ScannedToken | undefined => {
  const { bytes, dialect } = compile;
  const byte = bytes[i] as number;
  if (byte === STAR) return scanStarRun(bytes, i, dialect);
  if (byte === QUESTION) return { token: dialect.anyByte, next: i + 1 };
  if (byte === BACKSLASH) return scanEscape(bytes, i);
  if (byte === LBRACKET) return parseBracket(compile, i);
  return { token: { kind: 'byte', value: foldPlain(byte, compile.flags) }, next: i + 1 };
};

/** `closeAfter[i]` — the index of the first `]` at or after `i`, `bytes.length`
 *  when none: one backward pass, so a `[:` lookahead never scans twice. */
const indexClosers = (bytes: Uint8Array): Int32Array => {
  const closeAfter = new Int32Array(bytes.length + 1).fill(bytes.length);
  for (let i = bytes.length - 1; i >= 0; i--) {
    closeAfter[i] = bytes[i] === RBRACKET ? i : (closeAfter[i + 1] as number);
  }
  return closeAfter;
};

/** Tokenise a pattern's UTF-8 bytes, or `undefined` when the pattern can
 *  never match anything (an unterminated `[`, an unknown `[:class:]` name,
 *  or a trailing unescaped `\`). */
const tokenize = (
  bytes: Uint8Array,
  dialect: Dialect,
  flags: WildmatchFlags,
): ReadonlyArray<WildmatchToken> | undefined => {
  const tokens: WildmatchToken[] = [];
  const compile: Compile = {
    bytes,
    closeAfter: indexClosers(bytes),
    dialect,
    flags,
    sets: new Map(),
  };
  let i = 0;
  while (i < bytes.length) {
    const scanned = scanToken(compile, i);
    if (scanned === undefined) return undefined;
    tokens.push(scanned.token);
    i = scanned.next;
  }
  return tokens;
};

/** The `wildmatch` flags that change tokenisation: `pathname` is WM_PATHNAME,
 *  `caseFold` is git's case folding. */
export interface WildmatchFlags {
  readonly pathname: boolean;
  readonly caseFold: boolean;
}

/** Tokenise a pattern's bytes under `flags`, or `undefined` when git would
 *  abort and the pattern therefore matches nothing. */
export const tokenizeWildmatch = (
  pattern: Uint8Array,
  flags: WildmatchFlags,
): ReadonlyArray<WildmatchToken> | undefined =>
  tokenize(pattern, flags.pathname ? PATHNAME_DIALECT : REF_DIALECT, flags);

// Each step derives `cur` — the row for the tokens from this one on — from
// `next`, the row for the tokens after it. The caller hands in a zeroed `cur`.

// `star` matches zero or more of ANY byte — `wildmatch`'s `*`/`**` under
// flags 0, where a single `*` already crosses `/`.
const stepStar = (text: Uint8Array, next: Uint8Array, cur: Uint8Array): Uint8Array => {
  cur[text.length] = next[text.length] === 1 ? 1 : 0;
  // Stryker disable next-line ArithmeticOperator: equivalent — `cur` holds `text.length + 1` slots, so the extra turn writes past the end (a silent no-op on a typed array) and reads `undefined`; the turn at `text.length` then recomputes the value the line above already stored.
  for (let j = text.length - 1; j >= 0; j--) {
    cur[j] = next[j] === 1 || cur[j + 1] === 1 ? 1 : 0;
  }
  return cur;
};

// `segment` — `star` that stops at the first `/` it would have to consume.
const stepSegment = (text: Uint8Array, next: Uint8Array, cur: Uint8Array): Uint8Array => {
  cur[text.length] = next[text.length] === 1 ? 1 : 0;
  // Stryker disable next-line ArithmeticOperator: equivalent — `cur` holds `text.length + 1` slots, so the extra turn writes past the end (a silent no-op on a typed array); the turn at `text.length` then reads `undefined` past both arrays and recomputes the value the line above already stored.
  for (let j = text.length - 1; j >= 0; j--) {
    cur[j] = next[j] === 1 || (text[j] !== SLASH && cur[j + 1] === 1) ? 1 : 0;
  }
  return cur;
};

// `dirs` — nothing at all, or any run ending in a `/`. Rare (the WM_PATHNAME
// dialect only), so it keeps its own two rows.
const stepDirs = (text: Uint8Array, next: Uint8Array, cur: Uint8Array): Uint8Array => {
  const size = text.length + 1;
  const throughSlash = stepStar(
    text,
    stepByte(SLASH, text, next, new Uint8Array(size)),
    new Uint8Array(size),
  );
  for (let j = 0; j < size; j++) cur[j] = throughSlash[j] === 1 || next[j] === 1 ? 1 : 0;
  return cur;
};

const stepToken = (
  token: WildmatchToken,
  text: Uint8Array,
  next: Uint8Array,
  cur: Uint8Array,
): Uint8Array => {
  if (token.kind === 'star') return stepStar(text, next, cur);
  if (token.kind === 'segment') return stepSegment(text, next, cur);
  if (token.kind === 'dirs') return stepDirs(text, next, cur);
  if (token.kind === 'byte') return stepByte(token.value, text, next, cur);
  return stepSet(token.table, text, next, cur);
};

const stepByte = (
  value: number,
  text: Uint8Array,
  next: Uint8Array,
  cur: Uint8Array,
): Uint8Array => {
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. the extra turn reads `next[text.length + 1]` past the end, which is never `1`, so no cell is written whatever the comparison answers for the undefined byte beyond the text.
  for (let j = 0; j < text.length; j++) {
    if (text[j] === value && next[j + 1] === 1) cur[j] = 1;
  }
  return cur;
};

const stepSet = (
  table: Uint8Array,
  text: Uint8Array,
  next: Uint8Array,
  cur: Uint8Array,
): Uint8Array => {
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. the extra turn reads `next[text.length + 1]` past the end, which is never `1`, so no cell is written whatever the table answers for the undefined byte beyond the text.
  for (let j = 0; j < text.length; j++) {
    if (table[text[j] as number] === 1 && next[j + 1] === 1) cur[j] = 1;
  }
  return cur;
};

// Two rows swap roles per token instead of one allocation each; a row with no
// reachable cell ends the match, since every step only reads reachable cells.
// Under `caseFold` the caller hands in text already ASCII-lowered: the core
// lowers nothing at match time.
export const matchWildmatch = (
  tokens: ReadonlyArray<WildmatchToken>,
  text: Uint8Array,
): boolean => {
  let next = new Uint8Array(text.length + 1);
  let cur = new Uint8Array(text.length + 1);
  next[text.length] = 1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    cur.fill(0);
    stepToken(tokens[i] as WildmatchToken, text, next, cur);
    if (!cur.includes(1)) return false;
    [next, cur] = [cur, next];
  }
  return next[0] === 1;
};

/**
 * The ref-glob dialect `gc.<pattern>.*` and `name-rev`'s `--refs`/`--exclude`
 * share: git's `wildmatch(pattern, ref, 0)` — `*` and `?` cross `/` (no
 * `WM_PATHNAME`), `\x` escapes one byte, and `[…]` is a POSIX bracket
 * expression. Matched over UTF-8 bytes, not UTF-16 code units, because
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

type ByteTest = (byte: number) => boolean;

type RefGlobToken = { readonly kind: 'star' } | { readonly kind: 'match'; readonly test: ByteTest };

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
  while (j < bytes.length && bytes[j] !== RBRACKET) j += 1;
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
  return { token: { kind: 'match', test: bracketTest(negated, atoms) }, next: i };
};

interface ScannedToken {
  readonly token: RefGlobToken;
  readonly next: number;
}

// A run of one or more consecutive `*` — under flags 0 every count behaves
// identically (any run of bytes, slashes included), so the whole run
// collapses into a single `star` token.
const scanStarRun = (bytes: Uint8Array, i: number): ScannedToken => {
  let next = i + 1;
  while (bytes[next] === STAR) next += 1;
  return { token: { kind: 'star' }, next };
};

// `\x` — a literal `x`; `undefined` when `\` is the pattern's last byte
// (nothing to escape), which never matches (see module docs).
const scanEscape = (bytes: Uint8Array, i: number): ScannedToken | undefined => {
  const escaped = bytes[i + 1];
  if (escaped === undefined) return undefined;
  return { token: { kind: 'match', test: (b) => b === escaped }, next: i + 2 };
};

const scanToken = (bytes: Uint8Array, i: number): ScannedToken | undefined => {
  const byte = bytes[i] as number;
  if (byte === STAR) return scanStarRun(bytes, i);
  if (byte === QUESTION) return { token: { kind: 'match', test: () => true }, next: i + 1 };
  if (byte === BACKSLASH) return scanEscape(bytes, i);
  if (byte === LBRACKET) return parseBracket(bytes, i);
  return { token: { kind: 'match', test: (b) => b === byte }, next: i + 1 };
};

/** Tokenise a pattern's UTF-8 bytes, or `undefined` when the pattern can
 *  never match anything (an unterminated `[`, an unknown `[:class:]` name,
 *  or a trailing unescaped `\`). */
const tokenize = (bytes: Uint8Array): ReadonlyArray<RefGlobToken> | undefined => {
  const tokens: RefGlobToken[] = [];
  let i = 0;
  while (i < bytes.length) {
    const scanned = scanToken(bytes, i);
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
  for (let j = text.length - 1; j >= 0; j--) {
    cur[j] = next[j] === 1 || cur[j + 1] === 1 ? 1 : 0;
  }
  return cur;
};

const stepMatch = (test: ByteTest, text: Uint8Array, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(text.length + 1);
  for (let j = 0; j < text.length; j++) {
    if (test(text[j] as number) && next[j + 1] === 1) cur[j] = 1;
  }
  return cur;
};

const matchTokens = (tokens: ReadonlyArray<RefGlobToken>, text: Uint8Array): boolean => {
  let dp: Uint8Array = new Uint8Array(text.length + 1);
  dp[text.length] = 1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] as RefGlobToken;
    dp = token.kind === 'star' ? stepStar(text, dp) : stepMatch(token.test, text, dp);
  }
  return dp[0] === 1;
};

/** Compiles `pattern` once into a matcher `wildmatch(pattern, ref, 0)`
 *  agrees with byte-for-byte — full match, case-sensitive, `*`/`?` crossing
 *  `/`. Reuse the returned function across many refs instead of recompiling. */
export const compileRefGlob = (pattern: string): ((ref: string) => boolean) => {
  const tokens = tokenize(encode(pattern));
  if (tokens === undefined) return () => false;
  return (ref: string): boolean => matchTokens(tokens, encode(ref));
};

/** One-shot form of {@link compileRefGlob} for a single ref check. */
export const matchRefGlob = (pattern: string, ref: string): boolean => compileRefGlob(pattern)(ref);

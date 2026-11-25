// Test-side oracle: a branch-for-branch port of git's wildmatch.c `dowild`,
// the backtracking recursion. It shares no code with the matcher under test,
// so agreement between the two is evidence, not tautology. Byte arrays in;
// the NUL that ends a C string is `at` reading past the end; the three
// internal return values are kept as git has them. git's ctype tests are its
// own ASCII tables: bytes >= 0x80 never classify.

const WM_MATCH = 0;
const WM_NOMATCH = 1;
const WM_ABORT_ALL = -1;
const WM_ABORT_TO_STAR_STAR = -2;

const NUL = 0;
const SLASH = 0x2f;
const STAR = 0x2a;
const QUESTION = 0x3f;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const CARET = 0x5e;
const BANG = 0x21;
const DASH = 0x2d;
const COLON = 0x3a;
const CASE_OFFSET = 0x20;

export interface WildmatchFlags {
  readonly pathname: boolean;
  readonly caseFold: boolean;
}

interface Context {
  readonly pattern: Uint8Array;
  readonly text: Uint8Array;
  readonly flags: WildmatchFlags;
}

type Step =
  | { readonly done: true; readonly result: number }
  | { readonly done: false; readonly p: number; readonly t: number };

const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? NUL;

const isUpper = (c: number): boolean => c >= 0x41 && c <= 0x5a;
const isLower = (c: number): boolean => c >= 0x61 && c <= 0x7a;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number): boolean => isUpper(c) || isLower(c);
const isAlnum = (c: number): boolean => isAlpha(c) || isDigit(c);
const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isPrint = (c: number): boolean => c >= 0x20 && c <= 0x7e;
const isGraph = (c: number): boolean => c >= 0x21 && c <= 0x7e;
const isPunct = (c: number): boolean => isPrint(c) && !isAlnum(c) && !isSpace(c);
const isCntrl = (c: number): boolean => c <= 0x1f || c === 0x7f;
const isXdigit = (c: number): boolean =>
  isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isBlank = (c: number): boolean => c === 0x20 || c === 0x09;
const toLower = (c: number): number => (isUpper(c) ? c + CASE_OFFSET : c);
const toUpper = (c: number): number => (isLower(c) ? c - CASE_OFFSET : c);
const isGlobSpecial = (c: number): boolean =>
  c === STAR || c === QUESTION || c === OPEN_BRACKET || c === BACKSLASH;

const CLASS_TESTS: ReadonlyMap<string, (c: number) => boolean> = new Map([
  ['alnum', isAlnum],
  ['alpha', isAlpha],
  ['blank', isBlank],
  ['cntrl', isCntrl],
  ['digit', isDigit],
  ['graph', isGraph],
  ['lower', isLower],
  ['print', isPrint],
  ['punct', isPunct],
  ['space', isSpace],
  ['upper', isUpper],
  ['xdigit', isXdigit],
]);

const done = (result: number): Step => ({ done: true, result });
const resume = (p: number, t: number): Step => ({ done: false, p, t });

const isWholeComponentStarRun = (
  c: Context,
  pattern: number,
  prevP: number,
  p: number,
): boolean => {
  const startsComponent = prevP - pattern < 2 || at(c.pattern, prevP - 2) === SLASH;
  const next = at(c.pattern, p);
  const endsComponent =
    next === NUL || next === SLASH || (next === BACKSLASH && at(c.pattern, p + 1) === SLASH);
  return startsComponent && endsComponent;
};

// The text from `t` on holds a '/' (C string search for the byte).
const slashFrom = (c: Context, t: number): number => c.text.indexOf(SLASH, t);

const foldedText = (c: Context, byte: number): number => (c.flags.caseFold ? toLower(byte) : byte);

// git's `while (1)` loop of the star arm, with its literal fast-forward.
const starRun = (c: Context, p: number, t0: number, tCh0: number, matchSlash: boolean): number => {
  let t = t0;
  let tCh = tCh0;
  while (tCh !== NUL) {
    if (!isGlobSpecial(at(c.pattern, p))) {
      const pCh = foldedText(c, at(c.pattern, p));
      tCh = at(c.text, t);
      while (tCh !== NUL && (matchSlash || tCh !== SLASH)) {
        if (foldedText(c, tCh) === pCh) {
          tCh = foldedText(c, tCh);
          break;
        }
        tCh = at(c.text, ++t);
      }
      if (tCh !== pCh) return matchSlash ? WM_ABORT_ALL : WM_ABORT_TO_STAR_STAR;
    }
    const matched = dowild(c, p, t);
    if (matched !== WM_NOMATCH) {
      if (!matchSlash || matched !== WM_ABORT_TO_STAR_STAR) return matched;
    } else if (!matchSlash && tCh === SLASH) {
      return WM_ABORT_TO_STAR_STAR;
    }
    tCh = at(c.text, ++t);
  }
  return WM_ABORT_ALL;
};

const starArm = (c: Context, pattern: number, star: number, t: number, tCh: number): Step => {
  let p = star + 1;
  let matchSlash = !c.flags.pathname;
  if (at(c.pattern, p) === STAR) {
    const prevP = p;
    p++;
    while (at(c.pattern, p) === STAR) p++;
    if (c.flags.pathname) {
      matchSlash = isWholeComponentStarRun(c, pattern, prevP, p);
      if (matchSlash && at(c.pattern, p) === SLASH && dowild(c, p + 1, t) === WM_MATCH) {
        return done(WM_MATCH);
      }
    }
  }
  if (at(c.pattern, p) === NUL) {
    const crossesSlash = !matchSlash && slashFrom(c, t) !== -1;
    return done(crossesSlash ? WM_ABORT_TO_STAR_STAR : WM_MATCH);
  }
  if (!matchSlash && at(c.pattern, p) === SLASH) {
    const slash = slashFrom(c, t);
    return slash === -1 ? done(WM_ABORT_ALL) : resume(p, slash);
  }
  return done(starRun(c, p, t, tCh, matchSlash));
};

// The state a bracket expression scan threads through its members.
interface SetScan {
  p: number;
  pCh: number;
  prev: number;
  matched: boolean;
}

const rangeMember = (c: Context, scan: SetScan, tCh: number): boolean => {
  scan.pCh = at(c.pattern, ++scan.p);
  if (scan.pCh === BACKSLASH) {
    scan.pCh = at(c.pattern, ++scan.p);
    if (scan.pCh === NUL) return false;
  }
  if (tCh <= scan.pCh && tCh >= scan.prev) {
    scan.matched = true;
  } else if (c.flags.caseFold && isLower(tCh)) {
    const upper = toUpper(tCh);
    if (upper <= scan.pCh && upper >= scan.prev) scan.matched = true;
  }
  scan.pCh = 0;
  return true;
};

const nameOf = (c: Context, from: number, length: number): string =>
  String.fromCharCode(...c.pattern.subarray(from, from + length));

const classMember = (c: Context, scan: SetScan, tCh: number): boolean => {
  const s = scan.p + 2;
  scan.p = s;
  scan.pCh = at(c.pattern, scan.p);
  while (scan.pCh !== NUL && scan.pCh !== CLOSE_BRACKET) {
    scan.pCh = at(c.pattern, ++scan.p);
  }
  if (scan.pCh === NUL) return false;
  const length = scan.p - s - 1;
  if (length < 0 || at(c.pattern, scan.p - 1) !== COLON) {
    scan.p = s - 2;
    scan.pCh = OPEN_BRACKET;
    if (tCh === scan.pCh) scan.matched = true;
    return true;
  }
  const name = nameOf(c, s, length);
  const test = CLASS_TESTS.get(name);
  if (test === undefined) return false;
  const underFold = name === 'upper' && c.flags.caseFold && isLower(tCh);
  if (test(tCh) || underFold) scan.matched = true;
  scan.pCh = 0;
  return true;
};

// One member of a bracket expression; false is git's WM_ABORT_ALL.
const scanMember = (c: Context, scan: SetScan, tCh: number): boolean => {
  const { pattern } = c;
  if (scan.pCh === NUL) return false;
  if (scan.pCh === BACKSLASH) {
    scan.pCh = at(pattern, ++scan.p);
    if (scan.pCh === NUL) return false;
    if (tCh === scan.pCh) scan.matched = true;
    return true;
  }
  const next = at(pattern, scan.p + 1);
  if (scan.pCh === DASH && scan.prev !== NUL && next !== NUL && next !== CLOSE_BRACKET) {
    return rangeMember(c, scan, tCh);
  }
  if (scan.pCh === OPEN_BRACKET && next === COLON) return classMember(c, scan, tCh);
  if (tCh === scan.pCh) scan.matched = true;
  return true;
};

const bracketArm = (c: Context, bracket: number, t: number, tCh: number): Step => {
  const scan: SetScan = { p: bracket + 1, pCh: 0, prev: 0, matched: false };
  scan.pCh = at(c.pattern, scan.p);
  const negated = scan.pCh === CARET || scan.pCh === BANG;
  if (negated) scan.pCh = at(c.pattern, ++scan.p);
  do {
    if (!scanMember(c, scan, tCh)) return done(WM_ABORT_ALL);
    scan.prev = scan.pCh;
    scan.pCh = at(c.pattern, ++scan.p);
  } while (scan.pCh !== CLOSE_BRACKET);
  if (scan.matched === negated || (c.flags.pathname && tCh === SLASH)) return done(WM_NOMATCH);
  return resume(scan.p, t);
};

// One iteration of git's top-level loop for the byte at `p`.
const step = (c: Context, pattern: number, p: number, t: number): Step => {
  const tCh = foldedText(c, at(c.text, t));
  const pCh = foldedText(c, at(c.pattern, p));
  if (at(c.text, t) === NUL && pCh !== STAR) return done(WM_ABORT_ALL);
  if (pCh === QUESTION) {
    return c.flags.pathname && tCh === SLASH ? done(WM_NOMATCH) : resume(p, t);
  }
  if (pCh === STAR) return starArm(c, pattern, p, t, tCh);
  if (pCh === OPEN_BRACKET) return bracketArm(c, p, t, tCh);
  const literal = pCh === BACKSLASH ? at(c.pattern, p + 1) : pCh;
  if (tCh !== literal) return done(WM_NOMATCH);
  return resume(pCh === BACKSLASH ? p + 1 : p, t);
};

const dowild = (c: Context, pattern: number, text: number): number => {
  let p = pattern;
  let t = text;
  while (at(c.pattern, p) !== NUL) {
    const next = step(c, pattern, p, t);
    if (next.done) return next.result;
    p = next.p + 1;
    t = next.t + 1;
  }
  return at(c.text, t) === NUL ? WM_MATCH : WM_NOMATCH;
};

export const referenceWildmatch = (
  pattern: Uint8Array,
  text: Uint8Array,
  flags: WildmatchFlags,
): boolean => dowild({ pattern, text, flags }, 0, 0) === WM_MATCH;

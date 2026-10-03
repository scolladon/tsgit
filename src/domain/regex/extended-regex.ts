/**
 * git's `regcomp(pattern, REG_EXTENDED)` — GNU regex syntax, the engine git
 * bundles where the C library lacks one — translated to an ECMAScript RegExp
 * that answers whether a subject holds a match. `undefined` where regcomp
 * refuses the pattern.
 *
 * Without REG_NEWLINE, `.` and a negated bracket match a newline and `^`/`$`
 * anchor the whole subject. Repetition operators stack (`a+?` is `(a+)?`), a
 * bracket takes `\` literally and a leading `]` as a member, and the GNU
 * escapes (`\<`, `\>`, `\b`, `\B`, `\w`, `\W`, `\s`, `\S`, `` \` ``, `\'`)
 * apply. Character classes follow a UTF-8 locale.
 */

/** GNU's `RE_DUP_MAX`: the largest bound an interval accepts. */
const MAX_REPEAT = 0x7fff;
const WORD_CHARACTERS = '\\p{L}\\p{N}_';
const WORD = `[${WORD_CHARACTERS}]`;
const WORD_START = `(?<!${WORD})(?=${WORD})`;
const WORD_END = `(?<=${WORD})(?!${WORD})`;

const PLAIN_ANCHORS: ReadonlyMap<string, string> = new Map([
  ['^', '^'],
  ['$', '$'],
]);

const ESCAPED_ANCHORS: ReadonlyMap<string, string> = new Map([
  ['<', WORD_START],
  ['>', WORD_END],
  ['b', `(?:${WORD_START}|${WORD_END})`],
  ['B', `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`],
  ['`', '^'],
  ["'", '$'],
]);

const ESCAPED_CLASSES: ReadonlyMap<string, string> = new Map([
  ['w', WORD],
  ['W', `[^${WORD_CHARACTERS}]`],
  ['s', '\\s'],
  ['S', '\\S'],
]);

const GRAPHIC = '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}';

/** `[:name:]` bodies, placed inside the enclosing bracket. */
const CHARACTER_CLASSES: ReadonlyMap<string, string> = new Map([
  ['alpha', '\\p{Alphabetic}'],
  ['upper', '\\p{Uppercase}'],
  ['lower', '\\p{Lowercase}'],
  ['digit', '0-9'],
  ['xdigit', '0-9A-Fa-f'],
  ['alnum', '\\p{Alphabetic}\\p{Nd}'],
  ['space', '\\s'],
  ['blank', '\\t\\p{Zs}'],
  ['punct', '\\p{P}\\p{S}'],
  ['cntrl', '\\p{Cc}'],
  ['graph', GRAPHIC],
  ['print', `${GRAPHIC}\\p{Zs}`],
]);

const REPETITION_STARTS: ReadonlySet<string> = new Set(['*', '+', '?', '{']);
const BRACKET_SYMBOL_DELIMITERS: ReadonlySet<string> = new Set([':', '.', '=']);
const BACKREFERENCE = /^[1-9]$/;
const BOUND = /^\d*$/;
const VERBATIM = /^[A-Za-z0-9]$/;

/** Parse position over the pattern's code points, with the groups already closed. */
interface Cursor {
  readonly chars: ReadonlyArray<string>;
  pos: number;
  groups: number;
  readonly closedGroups: Set<number>;
}

/** A bracket member; `codePoint` is set only where it may bound a range. */
interface BracketMember {
  readonly source: string;
  readonly codePoint?: number;
}

type Translation = string | undefined;

export const compileExtendedRegex = (pattern: string): RegExp | undefined => {
  const cursor: Cursor = { chars: Array.from(pattern), pos: 0, groups: 0, closedGroups: new Set() };
  const source = parseAlternation(cursor, 0);
  return source === undefined ? undefined : new RegExp(source, 'su');
};

const peek = (c: Cursor, offset = 0): string | undefined => c.chars[c.pos + offset];

const next = (c: Cursor): string | undefined => {
  const ch = c.chars[c.pos];
  c.pos += 1;
  return ch;
};

const literal = (ch: string): string =>
  VERBATIM.test(ch) ? ch : `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;

const parseAlternation = (c: Cursor, nesting: number): Translation => {
  const branches: string[] = [];
  for (;;) {
    const branch = parseBranch(c, nesting);
    if (branch === undefined) return undefined;
    branches.push(branch);
    if (peek(c) !== '|') return branches.join('|');
    c.pos += 1;
  }
};

/** A `)` closes a branch only inside a group; at the top it is an ordinary character. */
const endsBranch = (c: Cursor, nesting: number): boolean => {
  const ch = peek(c);
  return ch === undefined || ch === '|' || (nesting > 0 && ch === ')');
};

const parseBranch = (c: Cursor, nesting: number): Translation => {
  let source = '';
  while (!endsBranch(c, nesting)) {
    const expression = parseExpression(c, nesting);
    if (expression === undefined) return undefined;
    source += expression;
  }
  return source;
};

/** A repetition opening an expression is refused; an anchor takes no repetition. */
const parseExpression = (c: Cursor, nesting: number): Translation => {
  if (REPETITION_STARTS.has(peek(c) as string)) return undefined;
  const anchor = readAnchor(c);
  if (anchor !== undefined) return anchor;
  const atom = parseAtom(c, nesting);
  return atom === undefined ? undefined : parseRepetitions(c, atom);
};

const readAnchor = (c: Cursor): string | undefined => {
  const plain = PLAIN_ANCHORS.get(peek(c) as string);
  if (plain !== undefined) {
    c.pos += 1;
    return plain;
  }
  if (peek(c) !== '\\') return undefined;
  const escaped = ESCAPED_ANCHORS.get(peek(c, 1) ?? '');
  if (escaped !== undefined) c.pos += 2;
  return escaped;
};

const parseAtom = (c: Cursor, nesting: number): Translation => {
  const ch = next(c) as string;
  if (ch === '.') return '.';
  if (ch === '[') return parseBracket(c);
  if (ch === '(') return parseGroup(c, nesting);
  if (ch === '\\') return parseEscape(c);
  return literal(ch);
};

const parseGroup = (c: Cursor, nesting: number): Translation => {
  c.groups += 1;
  const index = c.groups;
  const inner = parseAlternation(c, nesting + 1);
  if (inner === undefined || next(c) !== ')') return undefined;
  c.closedGroups.add(index);
  return `(${inner})`;
};

/** A trailing `\` is refused; a back-reference must name a group already closed. */
const parseEscape = (c: Cursor): Translation => {
  const ch = next(c);
  if (ch === undefined) return undefined;
  if (BACKREFERENCE.test(ch)) {
    return c.closedGroups.has(Number(ch)) ? `(?:\\${ch})` : undefined;
  }
  return ESCAPED_CLASSES.get(ch) ?? literal(ch);
};

/** Each further repetition applies to everything before it: `a+?` is `(?:a+)?`. */
const parseRepetitions = (c: Cursor, atom: string): Translation => {
  let source = atom;
  for (let stacked = false; REPETITION_STARTS.has(peek(c) as string); stacked = true) {
    const repetition = parseRepetition(c);
    if (repetition === undefined) return undefined;
    source = stacked ? `(?:${source})${repetition}` : `${source}${repetition}`;
  }
  return source;
};

const parseRepetition = (c: Cursor): Translation => {
  const ch = next(c);
  return ch === '{' ? parseInterval(c) : ch;
};

/** `{n}`, `{n,}`, `{,m}` (GNU's `{0,m}`) and `{n,m}`; anything else is refused. */
const parseInterval = (c: Cursor): Translation => {
  const low = readBound(c);
  if (low === undefined) return undefined;
  if (next(c) === '}') return low === '' ? undefined : boundedRepeat(low, low);
  const high = readBound(c);
  if (high === undefined || next(c) !== '}') return undefined;
  return high === '' ? openRepeat(low) : boundedRepeat(low, high);
};

/** The digits up to the next `,` or `}`; `undefined` when anything else intervenes. */
const readBound = (c: Cursor): string | undefined => {
  const start = c.pos;
  while (peek(c) !== undefined && peek(c) !== ',' && peek(c) !== '}') c.pos += 1;
  const digits = c.chars.slice(start, c.pos).join('');
  return peek(c) !== undefined && BOUND.test(digits) ? digits : undefined;
};

const openRepeat = (low: string): Translation => {
  const min = Number(low);
  return min > MAX_REPEAT ? undefined : `{${min},}`;
};

const boundedRepeat = (low: string, high: string): Translation => {
  const min = Number(low);
  const max = Number(high);
  return max > MAX_REPEAT || min > max ? undefined : `{${min},${max}}`;
};

const parseBracket = (c: Cursor): Translation => {
  const negated = peek(c) === '^';
  if (negated) c.pos += 1;
  const members: string[] = [];
  for (let first = true; ; first = false) {
    const ch = peek(c);
    if (ch === undefined) return undefined;
    if (ch === ']' && !first) {
      c.pos += 1;
      return `[${negated ? '^' : ''}${members.join('')}]`;
    }
    const member = parseBracketItem(c, first);
    if (member === undefined) return undefined;
    members.push(member);
  }
};

const parseBracketItem = (c: Cursor, first: boolean): Translation => {
  const start = parseBracketMember(c, first);
  if (start === undefined) return undefined;
  if (peek(c) !== '-' || peek(c, 1) === ']') return start.source;
  c.pos += 1;
  const end = parseBracketMember(c, true);
  return end === undefined ? undefined : rangeSource(start, end);
};

/** A `-` that neither opens the bracket nor precedes its `]` must bound a range. */
const parseBracketMember = (c: Cursor, acceptsHyphen: boolean): BracketMember | undefined => {
  const ch = next(c);
  if (ch === undefined) return undefined;
  if (ch === '[' && BRACKET_SYMBOL_DELIMITERS.has(peek(c) as string)) {
    return parseBracketSymbol(c, next(c) as string);
  }
  if (ch === '-' && !acceptsHyphen && peek(c) !== ']') return undefined;
  return characterMember(ch);
};

const characterMember = (ch: string): BracketMember => ({
  source: literal(ch),
  codePoint: ch.codePointAt(0) as number,
});

/** `[:class:]`, `[.c.]` (a collating symbol, may bound a range) or `[=c=]`. */
const parseBracketSymbol = (c: Cursor, delimiter: string): BracketMember | undefined => {
  const name = readBracketSymbol(c, delimiter);
  if (name === undefined) return undefined;
  if (delimiter === ':') {
    const body = CHARACTER_CLASSES.get(name.join(''));
    return body === undefined ? undefined : { source: body };
  }
  const [only] = name;
  if (only === undefined || name.length > 1) return undefined;
  return delimiter === '.' ? characterMember(only) : { source: literal(only) };
};

/** The symbol's characters up to `<delimiter>]`, consumed; `undefined` when unterminated. */
const readBracketSymbol = (c: Cursor, delimiter: string): ReadonlyArray<string> | undefined => {
  const start = c.pos;
  while (peek(c) !== undefined && !(peek(c) === delimiter && peek(c, 1) === ']')) c.pos += 1;
  if (peek(c) === undefined) return undefined;
  const name = c.chars.slice(start, c.pos);
  c.pos += 2;
  return name;
};

const rangeSource = (start: BracketMember, end: BracketMember): Translation => {
  if (start.codePoint === undefined || end.codePoint === undefined) return undefined;
  return start.codePoint > end.codePoint ? undefined : `${start.source}-${end.source}`;
};

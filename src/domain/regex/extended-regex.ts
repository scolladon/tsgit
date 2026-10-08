/**
 * git's `regcomp(pattern, REG_EXTENDED)` — GNU regex syntax, the engine git
 * bundles where the C library lacks one — compiled to a matcher that answers
 * whether a subject holds a match. `undefined` where regcomp refuses the
 * pattern, and where it nests groups or expands repetitions past this
 * engine's bounds (git overflows its stack or exhausts memory there).
 *
 * Without REG_NEWLINE, `.` and a negated bracket match a newline and `^`/`$`
 * anchor the whole subject. Repetition operators stack (`a+?` is `(a+)?`), a
 * bracket takes `\` literally and a leading `]` as a member, and the GNU
 * escapes (`\<`, `\>`, `\b`, `\B`, `\w`, `\W`, `\s`, `\S`, `` \` ``, `\'`)
 * apply. Character classes follow a UTF-8 locale.
 *
 * A pattern without back-references runs as a Thompson automaton, in time
 * linear in the subject. One with back-references needs backtracking, which
 * spends at most a fixed number of steps on a subject; one it cannot settle
 * within them answers no match. A back-reference reads the text its group
 * last captured on the path, which a later repetition copy that skips the
 * group leaves in place; one to a group no copy has captured matches nothing,
 * as glibc's `regexec` has it. The automaton
 * first refuses, in linear time, a subject such a pattern cannot match even
 * with each back-reference read as any text.
 * A subject lacking text every match must contain is refused before the
 * automaton runs, and a pattern spelling one of a few plain texts is a
 * substring search.
 */

/** GNU's `RE_DUP_MAX`: the largest bound an interval accepts. */
const MAX_REPEAT = 0x7fff;
/**
 * Deepest group nesting parsed, well inside the JavaScript stack this
 * recursive parser runs on; glibc's own recursion overflows near 20000.
 */
const MAX_GROUP_NESTING = 500;
/**
 * Most automaton instructions the expanded repetitions may take — room for
 * the widest interval over three characters. A match costs at most this many
 * steps per subject character.
 */
const MAX_PROGRAM_SIZE = 1 << 17;
/**
 * Most instructions the backtracking program may take — room for every
 * nameable group nested inside the widest interval. glibc spends over a
 * minute compiling an empty group repeated past it.
 */
const MAX_BACKTRACKING_PROGRAM_SIZE = 1 << 20;
/**
 * Steps the backtracking matcher takes on one subject before answering no
 * match — about 50 ms of work, where glibc settles typical exponential
 * patterns in a few. A step runs one instruction or compares one character.
 */
const MAX_BACKTRACK_STEPS = 1 << 22;
/** The groups a back-reference can name: `\1` to `\9`. */
const MAX_BACKREFERENCE = 9;
/** Memory slots before the repetition registers: a start and an end per nameable group. */
const CAPTURE_SLOTS = (MAX_BACKREFERENCE + 1) * 2;
/** Most texts a pattern may spell and still run as a substring search. */
const MAX_EXACT_TEXTS = 16;
const WORD_CHARACTERS = '\\p{L}\\p{N}_';
const WORD = `[${WORD_CHARACTERS}]`;
const FLAGS = 'su';

const CHAR = 0;
const ASSERT = 1;
const FORK = 2;
/** Records the position in a memory slot: a group's bounds, or where a repetition copy starts. */
const SAVE = 3;
/** Reads again the text a group captured. */
const BACKREF = 4;
/** Ends a copy of an unbounded repetition, leaving the repetition where the copy read nothing. */
const PROGRESS = 5;
const MATCH = 6;

/** What a position is known by: bits for the subject's start and end, and a word character either side. */
type Context = number;

const AT_START = 1;
const AT_END = 2;
const WORD_BEFORE = 4;
const WORD_AFTER = 8;
const CONTEXTS = 16;

/** Whether a zero-width assertion holds in a context. */
type Assertion = (context: Context) => boolean;

const wordBefore = (context: Context): boolean => (context & WORD_BEFORE) !== 0;
const wordAfter = (context: Context): boolean => (context & WORD_AFTER) !== 0;
/** A word character on one side only. */
const atWordBoundary = (context: Context): boolean => wordBefore(context) !== wordAfter(context);

/**
 * An automaton step. A `char` reads a code point its source — a one-character
 * ECMAScript pattern — matches; `code` is set where that is one code point.
 * `fork` targets are relative to the fork; a jump forks twice to one target.
 * Any other instruction is laid out as written: an ASSERT holds in the
 * contexts its operand has a bit for.
 */
type Instruction =
  | { readonly op: 'char'; readonly source: string; readonly code?: number }
  | { readonly op: 'fork'; readonly to: number; readonly or: number }
  | {
      readonly op: 'plain';
      readonly code: number;
      readonly operand: number;
      readonly target: number;
    };

/** Instructions laid out in order without copying: repeated parts are shared. */
interface Sequence {
  readonly size: number;
  readonly parts: ReadonlyArray<Fragment>;
}

type Fragment = Instruction | Sequence;

/** Texts a piece may spell, `undefined` where they are unknown or too many. */
type Spelt = ReadonlyArray<string> | undefined;

/** Sets of texts, all of one of which lie inside every match. */
type Alternatives = ReadonlyArray<ReadonlyArray<string>>;

/** The text a piece's matches are known to spell. */
interface Literals {
  /** The texts every match is one of, when the piece only ever matches those. */
  readonly exact: Spelt;
  /** Texts known to lie inside every match, each a run of literal characters. */
  readonly required: ReadonlyArray<string>;
  /** Alternatives every match chooses among. */
  readonly anyOf: ReadonlyArray<Alternatives>;
  /** Where a match may start: anywhere, or only where the subject starts. */
  readonly starts: Starts;
}

type Starts = 'anywhere' | 'subject-start';

/** A parsed expression: its program and its literal text. */
interface Piece {
  readonly fragment: Fragment;
  readonly literals: Literals;
}

interface Bounds {
  readonly min: number;
  readonly max: number;
}

/** Nothing known: a piece matching varied text, or a zero-width one a substring search cannot place. */
const OPAQUE: Literals = { exact: undefined, required: [], anyOf: [], starts: 'anywhere' };

const maskOf = (holds: Assertion): number => {
  let mask = 0;
  for (let context = 0; context < CONTEXTS; context += 1) mask |= Number(holds(context)) << context;
  return mask;
};

const plain = (code: number, operand: number, target = 0): Instruction => ({
  op: 'plain',
  code,
  operand,
  target,
});

const anchor = (holds: Assertion, literals = OPAQUE): Piece => ({
  fragment: plain(ASSERT, maskOf(holds)),
  literals,
});

const SUBJECT_START = anchor((context) => (context & AT_START) !== 0, {
  ...OPAQUE,
  starts: 'subject-start',
});
const SUBJECT_END = anchor((context) => (context & AT_END) !== 0);

const PLAIN_ANCHORS: ReadonlyMap<string, Piece> = new Map([
  ['^', SUBJECT_START],
  ['$', SUBJECT_END],
]);

const ESCAPED_ANCHORS: ReadonlyMap<string, Piece> = new Map([
  ['<', anchor((context) => wordAfter(context) && !wordBefore(context))],
  ['>', anchor((context) => wordBefore(context) && !wordAfter(context))],
  ['b', anchor(atWordBoundary)],
  ['B', anchor((context) => !atWordBoundary(context))],
  ['`', SUBJECT_START],
  ["'", SUBJECT_END],
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

const OPERATOR_BOUNDS: ReadonlyMap<string, Bounds> = new Map([
  ['*', { min: 0, max: Number.POSITIVE_INFINITY }],
  ['+', { min: 1, max: Number.POSITIVE_INFINITY }],
  ['?', { min: 0, max: 1 }],
]);

const REPETITION_STARTS: ReadonlySet<string> = new Set(['*', '+', '?', '{']);
const BRACKET_SYMBOL_DELIMITERS: ReadonlySet<string> = new Set([':', '.', '=']);
const BACKREFERENCE = /^[1-9]$/;
const BOUND = /^\d*$/;
const VERBATIM = /^[A-Za-z0-9]$/;

/**
 * Parse position over the pattern's code points, with the groups already
 * closed, for the engine the program is laid out for.
 */
interface Cursor {
  readonly engine: MatcherEngine;
  readonly chars: ReadonlyArray<string>;
  pos: number;
  groups: number;
  readonly closedGroups: Set<number>;
  backreferences: boolean;
  /** Instructions the repetitions laid out so far beyond their bodies — never given back. */
  laidOut: number;
  /** Memory slots the backtracking program uses: the captures', then a register per repetition. */
  slots: number;
}

/** A bracket member; `codePoint` is set only where it may bound a range. */
interface BracketMember {
  readonly source: string;
  readonly codePoint?: number;
}

type Translation = Piece | undefined;

/** How a matcher runs: in time linear in the subject, or backtracking — exponential at worst. */
export type MatcherEngine = 'linear' | 'backtracking';

/** Consulted every so often while a match runs; a throw stops it. It must not run that matcher. */
export type MatchCheck = () => void;

export interface ExtendedRegex {
  readonly engine: MatcherEngine;
  /** Whether `subject` holds a match; the automaton consults `check` as it steps. */
  readonly test: (subject: string, check?: MatchCheck) => boolean;
}

export const compileExtendedRegex = (pattern: string): ExtendedRegex | undefined => {
  const automaton = parse(pattern, 'linear');
  if (automaton === undefined) return undefined;
  if (!automaton.backreferences) return matcherOf(automaton.piece);
  const captured = parse(pattern, 'backtracking');
  return captured === undefined ? undefined : backtracking(automaton.piece, captured);
};

/** A pattern parsed for one engine. */
interface Parsed {
  readonly piece: Piece;
  readonly backreferences: boolean;
  readonly slots: number;
}

/**
 * The backtracking program also records where groups start and end, empty
 * ones included, which the automaton leaves out: a repetition of an empty
 * group costs it nothing but lays out the backtracking program's records.
 */
const PROGRAM_LIMITS: Readonly<Record<MatcherEngine, number>> = {
  linear: MAX_PROGRAM_SIZE,
  backtracking: MAX_BACKTRACKING_PROGRAM_SIZE,
};

const parse = (pattern: string, engine: MatcherEngine): Parsed | undefined => {
  const cursor: Cursor = {
    engine,
    chars: Array.from(pattern),
    pos: 0,
    groups: 0,
    closedGroups: new Set(),
    backreferences: false,
    laidOut: 0,
    slots: CAPTURE_SLOTS,
  };
  const piece = parseAlternation(cursor, 0);
  if (piece === undefined || sizeOf(piece.fragment) > PROGRAM_LIMITS[engine]) return undefined;
  return { piece, backreferences: cursor.backreferences, slots: cursor.slots };
};

/** A lone surrogate is one character to the automaton but half of one to a substring search. */
const LONE_SURROGATE = /\p{Cs}/u;

const isPlainText = (exact: Spelt): exact is ReadonlyArray<string> =>
  exact !== undefined && !exact.some((text) => LONE_SURROGATE.test(text));

/**
 * The automaton reads each back-reference as any text: a subject it refuses
 * cannot match, and is refused in linear time before the backtracking.
 */
const backtracking = (piece: Piece, { piece: captured, slots }: Parsed): ExtendedRegex => {
  const { test } = matcherOf(piece);
  const matches = backtracker(captured.fragment, captured.literals.starts, slots);
  return {
    engine: 'backtracking',
    test: (subject, check = IGNORE) => test(subject, check) && matches(subject, check),
  };
};

const linear = (test: ExtendedRegex['test']): ExtendedRegex => ({ engine: 'linear', test });

const holdsAll = (subject: string, texts: ReadonlyArray<string>): boolean =>
  texts.every((text) => subject.includes(text));

const matcherOf = ({ fragment, literals }: Piece): ExtendedRegex => {
  const { exact, required, anyOf, starts } = literals;
  if (isPlainText(exact)) return linear((subject) => exact.some((text) => subject.includes(text)));
  const matches = automaton(fragment, starts);
  return linear(
    (subject, check) =>
      holdsAll(subject, required) &&
      anyOf.every((sets) => sets.some((texts) => holdsAll(subject, texts))) &&
      matches(subject, check),
  );
};

const peek = (c: Cursor, offset = 0): string | undefined => c.chars[c.pos + offset];

const next = (c: Cursor): string | undefined => {
  const ch = c.chars[c.pos];
  c.pos += 1;
  return ch;
};

const literal = (ch: string): string =>
  VERBATIM.test(ch) ? ch : `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;

/** An expression consuming one character `source` matches. */
const characterPiece = (source: string): Piece => ({
  fragment: { op: 'char', source },
  literals: OPAQUE,
});

const literalPiece = (ch: string): Piece => ({
  fragment: { op: 'char', source: literal(ch), code: ch.codePointAt(0) as number },
  literals: { ...OPAQUE, exact: [ch], required: [ch] },
});

const parseAlternation = (c: Cursor, nesting: number): Translation => {
  const branches: Piece[] = [];
  for (;;) {
    const branch = parseBranch(c, nesting);
    if (branch === undefined) return undefined;
    branches.push(branch);
    if (peek(c) !== '|') return alternatePieces(branches);
    c.pos += 1;
  }
};

/**
 * A match spells one of the branches' texts, while they stay few, and all of
 * one branch's required texts; it starts at the subject's start when each
 * branch does.
 */
const alternativeLiterals = (branches: ReadonlyArray<Piece>): Literals => {
  const exact = branches.map(({ literals }) => literals.exact);
  const texts = exact.flatMap((spelt) => spelt ?? []);
  const starts = branches.every(({ literals }) => literals.starts === 'subject-start');
  return {
    exact: exact.includes(undefined) || texts.length > MAX_EXACT_TEXTS ? undefined : texts,
    required: [],
    anyOf: [branches.map(({ literals }) => literals.required)],
    starts: starts ? 'subject-start' : 'anywhere',
  };
};

const alternatePieces = (branches: ReadonlyArray<Piece>): Piece => ({
  fragment: alternate(branches.map((branch) => branch.fragment)),
  literals: branches.length === 1 ? (branches[0] as Piece).literals : alternativeLiterals(branches),
});

/** A `)` closes a branch only inside a group; at the top it is an ordinary character. */
const endsBranch = (c: Cursor, nesting: number): boolean => {
  const ch = peek(c);
  return ch === undefined || ch === '|' || (nesting > 0 && ch === ')');
};

const parseBranch = (c: Cursor, nesting: number): Translation => {
  const pieces: Piece[] = [];
  while (!endsBranch(c, nesting)) {
    const expression = parseExpression(c, nesting);
    if (expression === undefined) return undefined;
    pieces.push(expression);
  }
  return {
    fragment: sequence(pieces.map((piece) => piece.fragment)),
    literals: concatenatedLiterals(pieces.map((piece) => piece.literals)),
  };
};

/**
 * Adjacent pieces spelling one text each spell one run; every run and every
 * inner requirement is required, and every part's alternatives are chosen.
 */
const concatenatedLiterals = (parts: ReadonlyArray<Literals>): Literals => {
  const required: string[] = [];
  let run = '';
  for (const { exact, required: inner } of parts) {
    if (exact?.length === 1) {
      run += exact[0];
      continue;
    }
    required.push(run);
    for (const text of inner) required.push(text);
    run = '';
  }
  required.push(run);
  const exact = parts.reduce<Spelt>((texts, part) => spell(texts, part.exact), ['']);
  const starts = parts[0]?.starts ?? 'anywhere';
  return { exact, required, anyOf: parts.flatMap((part) => part.anyOf), starts };
};

/** Each prefix followed by each suffix; `undefined` where either is unknown or they spell too many. */
const spell = (prefixes: Spelt, suffixes: Spelt): Spelt => {
  if (prefixes === undefined || suffixes === undefined) return undefined;
  if (prefixes.length * suffixes.length > MAX_EXACT_TEXTS) return undefined;
  return prefixes.flatMap((prefix) => suffixes.map((suffix) => prefix + suffix));
};

/** A repetition opening an expression is refused; an anchor takes no repetition. */
const parseExpression = (c: Cursor, nesting: number): Translation => {
  if (REPETITION_STARTS.has(peek(c) as string)) return undefined;
  const anchor = readAnchor(c);
  if (anchor !== undefined) return anchor;
  const atom = parseAtom(c, nesting);
  return atom === undefined ? undefined : parseRepetitions(c, atom);
};

const readAnchor = (c: Cursor): Piece | undefined => {
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
  if (ch === '.') return characterPiece('.');
  if (ch === '(') return parseGroup(c, nesting);
  if (ch === '\\') return parseEscape(c);
  if (ch !== '[') return literalPiece(ch);
  const bracket = parseBracket(c);
  return bracket === undefined ? undefined : characterPiece(bracket);
};

const parseGroup = (c: Cursor, nesting: number): Translation => {
  if (nesting >= MAX_GROUP_NESTING) return undefined;
  c.groups += 1;
  const index = c.groups;
  const inner = parseAlternation(c, nesting + 1);
  if (inner === undefined || next(c) !== ')') return undefined;
  c.closedGroups.add(index);
  return captured(c, index, inner);
};

/** The backtracking program records where a group a back-reference can name starts and ends. */
const captured = (c: Cursor, index: number, inner: Piece): Piece => {
  if (c.engine === 'linear' || index > MAX_BACKREFERENCE) return inner;
  const start = index * 2;
  return {
    fragment: sequence([plain(SAVE, start), inner.fragment, plain(SAVE, start + 1)]),
    literals: inner.literals,
  };
};

/** A trailing `\` is refused. */
const parseEscape = (c: Cursor): Translation => {
  const ch = next(c);
  if (ch === undefined) return undefined;
  if (BACKREFERENCE.test(ch)) return parseBackreference(c, ch);
  const escapedClass = ESCAPED_CLASSES.get(ch);
  return escapedClass === undefined ? literalPiece(ch) : characterPiece(escapedClass);
};

/**
 * A back-reference must name a group already closed; the pattern then needs
 * backtracking, and the automaton reads the reference as any text.
 */
const parseBackreference = (c: Cursor, digit: string): Translation => {
  const group = Number(digit);
  if (!c.closedGroups.has(group)) return undefined;
  c.backreferences = true;
  const fragment =
    c.engine === 'linear'
      ? repeatFragment(sameCopies(characterPiece('.').fragment), ANY_RUN)
      : plain(BACKREF, group);
  return { fragment, literals: OPAQUE };
};

const ANY_RUN: Bounds = { min: 0, max: Number.POSITIVE_INFINITY };

/** A repeated piece and the repetition still to apply to it. */
interface PendingRepetition {
  readonly piece: Piece;
  readonly bounds?: Bounds;
}

/** Each further repetition applies to everything before it: `a+?` is `(a+)?`. */
const parseRepetitions = (c: Cursor, atom: Piece): Translation => {
  let pending: PendingRepetition | undefined = { piece: atom };
  while (pending !== undefined && REPETITION_STARTS.has(peek(c) as string)) {
    const outer = parseRepetition(c);
    pending = outer === undefined ? undefined : stackRepetition(c, pending, outer);
  }
  if (pending?.bounds === undefined) return pending?.piece;
  return repeat(c, pending.piece, pending.bounds);
};

/** Folds `outer` into the pending repetition where the two make one, so stacks stay shallow. */
const stackRepetition = (
  c: Cursor,
  { piece, bounds }: PendingRepetition,
  outer: Bounds,
): PendingRepetition | undefined => {
  if (bounds === undefined) return { piece, bounds: outer };
  if (absorbs(bounds)) return { piece, bounds: product(bounds, outer) };
  const repeated = repeat(c, piece, bounds);
  return repeated === undefined ? undefined : { piece: repeated, bounds: outer };
};

/** `R{a,b}{c,d}` is `R{ac,bd}` when the inner repetition is `*`, `+`, `?`, `{0}` or `{1}`. */
const absorbs = (inner: Bounds): boolean =>
  inner.min <= 1 && (inner.max <= 1 || inner.max === Number.POSITIVE_INFINITY);

const product = (inner: Bounds, outer: Bounds): Bounds => ({
  min: inner.min * outer.min,
  max: inner.max === 0 || outer.max === 0 ? 0 : inner.max * outer.max,
});

/** Copies that take the running total past the program's limit are refused. */
const repeat = (c: Cursor, piece: Piece, bounds: Bounds): Translation => {
  const fragment = repeatFragment(copiesOf(c, piece), bounds);
  c.laidOut += Math.max(0, sizeOf(fragment) - sizeOf(piece.fragment));
  if (c.laidOut > PROGRAM_LIMITS[c.engine]) return undefined;
  return {
    fragment,
    // Whatever one copy requires, a repetition holding a copy requires too.
    literals: bounds.min === 0 ? OPAQUE : { ...piece.literals, exact: undefined },
  };
};

const parseRepetition = (c: Cursor): Bounds | undefined => {
  const ch = next(c) as string;
  return ch === '{' ? parseInterval(c) : OPERATOR_BOUNDS.get(ch);
};

/** `{n}`, `{n,}`, `{,m}` (GNU's `{0,m}`) and `{n,m}`; anything else is refused. */
const parseInterval = (c: Cursor): Bounds | undefined => {
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

const openRepeat = (low: string): Bounds | undefined => {
  const min = Number(low);
  return min > MAX_REPEAT ? undefined : { min, max: Number.POSITIVE_INFINITY };
};

const boundedRepeat = (low: string, high: string): Bounds | undefined => {
  const min = Number(low);
  const max = Number(high);
  return max > MAX_REPEAT || min > max ? undefined : { min, max };
};

/** Where an item sits in a bracket expression: its first, or any later one. */
type ItemPosition = 'opening' | 'inner';
/** Where a member sits: an item's start, or the end of a range, where `-` is literal. */
type MemberPosition = ItemPosition | 'range-end';

const parseBracket = (c: Cursor): string | undefined => {
  const negated = peek(c) === '^';
  if (negated) c.pos += 1;
  const members: string[] = [];
  for (let at: ItemPosition = 'opening'; ; at = 'inner') {
    const ch = peek(c);
    if (ch === undefined) return undefined;
    if (ch === ']' && at === 'inner') {
      c.pos += 1;
      return `[${negated ? '^' : ''}${members.join('')}]`;
    }
    const member = parseBracketItem(c, at);
    if (member === undefined) return undefined;
    members.push(member);
  }
};

const parseBracketItem = (c: Cursor, at: ItemPosition): string | undefined => {
  const start = parseBracketMember(c, at);
  if (start === undefined) return undefined;
  if (peek(c) !== '-' || peek(c, 1) === ']') return start.source;
  c.pos += 1;
  const end = parseBracketMember(c, 'range-end');
  return end === undefined ? undefined : rangeSource(start, end);
};

/** A `-` that neither opens the bracket nor precedes its `]` must bound a range. */
const parseBracketMember = (c: Cursor, at: MemberPosition): BracketMember | undefined => {
  const ch = next(c);
  if (ch === undefined) return undefined;
  if (ch === '[' && BRACKET_SYMBOL_DELIMITERS.has(peek(c) as string)) {
    return parseBracketSymbol(c, next(c) as string);
  }
  if (ch === '-' && at === 'inner' && peek(c) !== ']') return undefined;
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

const rangeSource = (start: BracketMember, end: BracketMember): string | undefined => {
  if (start.codePoint === undefined || end.codePoint === undefined) return undefined;
  return start.codePoint > end.codePoint ? undefined : `${start.source}-${end.source}`;
};

const START = 0;

const sizeOf = (fragment: Fragment): number => ('parts' in fragment ? fragment.size : 1);

/** The fragments in order; empty ones are dropped, lest a shared copy visit them each time. */
const sequence = (fragments: ReadonlyArray<Fragment>): Sequence => {
  const parts = fragments.filter((fragment) => sizeOf(fragment) > 0);
  return { size: parts.reduce((total, part) => total + sizeOf(part), 0), parts };
};

const fork = (to: number, or: number): Instruction => ({ op: 'fork', to, or });

/** Each branch but the last is forked past and, once matched, jumps past the rest. */
const alternate = (branches: ReadonlyArray<Fragment>): Fragment => {
  const [last, ...others] = [...branches].reverse() as [Fragment, ...Fragment[]];
  const parts: Fragment[] = [last];
  let rest = sizeOf(last);
  for (const branch of others) {
    const size = sizeOf(branch);
    parts.push(fork(rest + 1, rest + 1), branch, fork(1, size + 2));
    rest += size + 2;
  }
  return sequence(parts.reverse());
};

/** A repeated body as a bounded copy lays it out, and as an unbounded repetition's copy does. */
interface Copies {
  readonly body: Fragment;
  readonly loop: Fragment;
}

const sameCopies = (body: Fragment): Copies => ({ body, loop: body });

/**
 * The automaton repeats the body as it is. In the backtracking program a
 * copy of an unbounded repetition records where it starts in a register of
 * its own, so a copy reading nothing ends the repetition instead of looping.
 */
const copiesOf = (c: Cursor, { fragment }: Piece): Copies => {
  if (c.engine === 'linear') return sameCopies(fragment);
  const register = c.slots;
  c.slots += 1;
  return {
    body: fragment,
    loop: sequence([plain(SAVE, register), fragment, plain(PROGRESS, register)]),
  };
};

/**
 * `min` copies of the body, then a skippable copy jumping back to its fork or
 * `max - min` copies, each skipping past the rest; copies share the body. An
 * empty body repeats to itself, at no cost however large the bounds.
 */
const repeatFragment = ({ body, loop }: Copies, { min, max }: Bounds): Fragment => {
  if (sizeOf(body) === 0) return body;
  const required = Array.from({ length: min }, () => body);
  if (max === Number.POSITIVE_INFINITY) {
    const size = sizeOf(loop);
    return sequence([...required, fork(1, size + 2), loop, fork(-size - 1, -size - 1)]);
  }
  const size = sizeOf(body);
  const optional = Array.from({ length: max - min }, (_, index) =>
    sequence([fork(1, (max - min - index) * (size + 1)), body]),
  );
  return sequence([...required, ...optional]);
};

const ASCII = 128;
/** The first code point spelt with two code units. */
const SURROGATE_PAIR = 0x10000;
const STICKY_FLAGS = `${FLAGS}y`;
const MATCHED = -1;
const NOWHERE = -1;

type CharInstruction = Extract<Instruction, { readonly op: 'char' }>;

/** The code points a `char` reads: ASCII ones by table, others by a sticky pattern run on the subject. */
interface CharClass {
  readonly source: string;
  readonly ascii: Uint8Array;
  /** `undefined` where no code point past ASCII belongs. */
  readonly beyond: RegExp | undefined;
}

/** A program laid out flat, ending in MATCH: per instruction its kind and operands. */
interface Program {
  readonly ops: Uint8Array;
  /** A char's class, an assertion's mask, or a fork's first target. */
  readonly operand: Int32Array;
  /** A fork's second target. */
  readonly target: Int32Array;
  readonly classes: ReadonlyArray<CharClass>;
}

/** Finds, from its `lastIndex`, the next code point a match can begin with. */
type Leading = RegExp;

/**
 * Buffers every run of one automaton reuses — test never re-enters itself.
 * `joined` holds the step at which each instruction last joined `pending`.
 */
interface Threads {
  readonly pending: Int32Array;
  readonly ready: Int32Array;
  readonly joined: Float64Array;
  step: number;
}

interface Machine {
  readonly program: Program;
  readonly starts: Starts;
  /** Unset where a match may be empty or begin with any ASCII code point. */
  readonly leading: Leading | undefined;
  /** Set where the program asserts on word characters. */
  readonly word: CharClass | undefined;
  readonly threads: Threads;
}

/**
 * Where a run stands: its index, the threads pending there, whether a word
 * character precedes it and the threads stepped since the check last ran.
 */
interface Scan {
  at: number;
  count: number;
  wordBefore: boolean;
  stepped: number;
}

/** Threads stepped between two checks: a few milliseconds of work. */
const CHECK_INTERVAL = 1 << 16;

/** What both engines know of a laid-out program before they run it. */
type Layout = Omit<Machine, 'threads'>;

const layOutMachine = (fragment: Fragment, starts: Starts): Layout => {
  const instructions: Instruction[] = [];
  flatten(fragment, instructions);
  const program = layOut(instructions);
  return {
    program,
    starts,
    leading: starts === 'anywhere' ? leadingOf(program) : undefined,
    word: program.ops.includes(ASSERT) ? classOf({ op: 'char', source: WORD }) : undefined,
  };
};

const automaton = (fragment: Fragment, starts: Starts): ExtendedRegex['test'] => {
  const layout = layOutMachine(fragment, starts);
  const size = layout.program.ops.length;
  const machine: Machine = {
    ...layout,
    threads: {
      pending: new Int32Array(size),
      ready: new Int32Array(size),
      joined: new Float64Array(size),
      step: 0,
    },
  };
  return (subject, check = IGNORE) => run(machine, subject, check);
};

const IGNORE: MatchCheck = () => undefined;

const flatten = (fragment: Fragment, program: Instruction[]): void => {
  if (!('parts' in fragment)) {
    program.push(fragment);
    return;
  }
  for (const part of fragment.parts) flatten(part, program);
};

const layOut = (instructions: ReadonlyArray<Instruction>): Program => {
  const ops = new Uint8Array(instructions.length + 1).fill(MATCH);
  const operand = new Int32Array(instructions.length);
  const target = new Int32Array(instructions.length);
  const classes: CharClass[] = [];
  const indexes = new Map<string, number>();
  for (const [pc, instruction] of instructions.entries()) {
    if (instruction.op === 'char') {
      [ops[pc], operand[pc]] = [CHAR, classIndex(instruction, indexes, classes)];
    } else if (instruction.op === 'fork') {
      [ops[pc], operand[pc], target[pc]] = [FORK, pc + instruction.to, pc + instruction.or];
    } else {
      [ops[pc], operand[pc], target[pc]] = [
        instruction.code,
        instruction.operand,
        instruction.target,
      ];
    }
  }
  return { ops, operand, target, classes };
};

/** One class per distinct source, however many instructions read it. */
const classIndex = (
  instruction: CharInstruction,
  indexes: Map<string, number>,
  classes: CharClass[],
): number => {
  const known = indexes.get(instruction.source);
  if (known !== undefined) return known;
  indexes.set(instruction.source, classes.length);
  classes.push(classOf(instruction));
  return classes.length - 1;
};

const classOf = ({ source, code }: CharInstruction): CharClass => {
  const pattern = new RegExp(source, STICKY_FLAGS);
  const ascii = new Uint8Array(ASCII);
  for (let unit = 0; unit < ASCII; unit += 1) {
    ascii[unit] = Number(readsAt(pattern, String.fromCharCode(unit), 0));
  }
  return { source, ascii, beyond: code !== undefined && code < ASCII ? undefined : pattern };
};

const readsAt = (pattern: RegExp, subject: string, at: number): boolean => {
  pattern.lastIndex = at;
  return pattern.test(subject);
};

const accepts = (charClass: CharClass, code: number, subject: string, at: number): boolean => {
  if (code < ASCII) return charClass.ascii[code] === 1;
  return charClass.beyond !== undefined && readsAt(charClass.beyond, subject, at);
};

/**
 * What every thread starting afresh reads first, through every fork and
 * instruction reading nothing; `undefined` where one reaches the match or a
 * back-reference without reading, or where one reads any ASCII code point.
 */
const leadingOf = (program: Program): Leading | undefined => {
  const { ops, operand, target, classes } = program;
  const seen = new Uint8Array(ops.length);
  const sources = new Set<number>();
  for (let pending = [START], pc = pending.pop(); pc !== undefined; pc = pending.pop()) {
    if (seen[pc] === 1) continue;
    seen[pc] = 1;
    const op = ops[pc];
    if (op === MATCH || op === BACKREF) return undefined;
    if (op === FORK) pending.push(operand[pc] as number, target[pc] as number);
    else if (op === CHAR) sources.add(operand[pc] as number);
    else pending.push(pc + 1);
  }
  const leading = [...sources].map((index) => classes[index] as CharClass);
  if (leading.some((charClass) => !charClass.ascii.includes(0))) return undefined;
  return new RegExp(leading.map((charClass) => charClass.source).join('|'), `${FLAGS}g`);
};

/**
 * Threads start at every position — or only the first, where no later start
 * can match — and step together, one code point at a time. Where no thread
 * is pending, the run jumps to the next code point a match can begin with.
 */
const run = (machine: Machine, subject: string, check: MatchCheck): boolean => {
  const { program, threads } = machine;
  const scan: Scan = { at: 0, count: 0, wordBefore: false, stepped: 0 };
  threads.step += 1;
  while (restart(machine, subject, scan)) {
    const { at } = scan;
    const code = subject.codePointAt(at);
    const wordAfter = isWord(machine, subject, at);
    const ready = follow(program, threads, scan.count, contextOf(scan, code, wordAfter));
    if (ready === MATCHED) return true;
    if (code === undefined) return false;
    consult(scan, ready, check);
    threads.step += 1;
    scan.count = advance(machine, subject, at, ready, code);
    scan.at = at + (code < SURROGATE_PAIR ? 1 : 2);
    scan.wordBefore = wordAfter;
  }
  return false;
};

const consult = (scan: Scan, ready: number, check: MatchCheck): void => {
  scan.stepped += ready + 1;
  if (scan.stepped < CHECK_INTERVAL) return;
  scan.stepped = 0;
  check();
};

/**
 * Joins a thread starting afresh where one may, first jumping to where a
 * match can begin when none is pending; `false` where none can begin.
 */
const restart = (machine: Machine, subject: string, scan: Scan): boolean => {
  const { starts, leading, threads } = machine;
  if (scan.at > 0 && starts === 'subject-start') return scan.count > 0;
  if (scan.count === 0 && leading !== undefined) {
    const at = nextLeading(leading, subject, scan.at);
    if (at === NOWHERE) return false;
    if (at !== scan.at) {
      scan.at = at;
      scan.wordBefore = isWordBefore(machine, subject, at);
    }
  }
  scan.count = join(threads, scan.count, START);
  return true;
};

const nextLeading = (leading: Leading, subject: string, from: number): number => {
  leading.lastIndex = from;
  return leading.test(subject) ? previousStart(subject, leading.lastIndex) : NOWHERE;
};

/** Where the code point ending at `at` starts: a pair's two code units back. */
const previousStart = (subject: string, at: number): number =>
  (subject.codePointAt(at - 2) ?? 0) < SURROGATE_PAIR ? at - 1 : at - 2;

const isWord = ({ word }: Layout, subject: string, at: number): boolean => {
  const code = subject.codePointAt(at);
  return word !== undefined && code !== undefined && accepts(word, code, subject, at);
};

/** Whether the code point ending at `at` is a word character. */
const isWordBefore = (layout: Layout, subject: string, at: number): boolean =>
  at > 0 && isWord(layout, subject, previousStart(subject, at));

const contextOf = (scan: Scan, code: number | undefined, wordAfter: boolean): Context =>
  (scan.at === 0 ? AT_START : 0) |
  (code === undefined ? AT_END : 0) |
  (scan.wordBefore ? WORD_BEFORE : 0) |
  (wordAfter ? WORD_AFTER : 0);

/** Adds `pc` to the pending threads unless it joined them this step; the new count. */
const join = (threads: Threads, count: number, pc: number): number => {
  if (threads.joined[pc] === threads.step) return count;
  threads.joined[pc] = threads.step;
  threads.pending[count] = pc;
  return count + 1;
};

/**
 * Drains the pending threads through forks and holding assertions, each
 * instruction once per step, into the threads ready at a character; MATCHED
 * where one reaches the match.
 */
const follow = (program: Program, threads: Threads, pending: number, context: Context): number => {
  const { ops, operand, target } = program;
  let count = pending;
  let ready = 0;
  while (count > 0) {
    count -= 1;
    const pc = threads.pending[count] as number;
    const op = ops[pc];
    if (op === MATCH) return MATCHED;
    if (op === CHAR) {
      threads.ready[ready] = pc;
      ready += 1;
    } else if (op === FORK) {
      count = join(threads, join(threads, count, operand[pc] as number), target[pc] as number);
    } else if (((operand[pc] as number) >> context) & 1) count = join(threads, count, pc + 1);
  }
  return ready;
};

/** The ready threads that read the code point at `at`, pending one step on; their count. */
const advance = (
  { program, threads }: Machine,
  subject: string,
  at: number,
  ready: number,
  code: number,
): number => {
  let count = 0;
  for (let index = 0; index < ready; index += 1) {
    const pc = threads.ready[index] as number;
    const charClass = program.classes[program.operand[pc] as number] as CharClass;
    if (accepts(charClass, code, subject, at)) count = join(threads, count, pc + 1);
  }
  return count;
};

/** No position recorded: an unset capture or register. */
const UNSET = -1;
/** From the end of an unbounded repetition's copy to the instruction after the repetition. */
const PAST_JUMP_BACK = 2;

/**
 * One backtracking path and the ways back from it, reused by every run.
 * `memory` holds each capture's start and end, then each repetition's
 * register; `trail` its earlier values, a slot and a value per write, and
 * `choices` the forks' other targets, each with its position and the trail's
 * length there.
 */
interface Path {
  pc: number;
  at: number;
  readonly memory: Int32Array;
  readonly trail: number[];
  readonly choices: number[];
}

/** The work one subject has taken, and when the check next runs. */
interface Budget {
  steps: number;
  nextCheck: number;
  readonly check: MatchCheck;
}

interface Backtracker extends Layout {
  readonly path: Path;
}

/** How a run from one position ends. */
type Outcome = 'matched' | 'failed' | 'exhausted';

const backtracker = (
  fragment: Fragment,
  starts: Starts,
  slots: number,
): ((subject: string, check: MatchCheck) => boolean) => {
  const machine: Backtracker = {
    ...layOutMachine(fragment, starts),
    path: { pc: START, at: 0, memory: new Int32Array(slots), trail: [], choices: [] },
  };
  return (subject, check) => backtrack(machine, subject, check);
};

/**
 * Runs from each position a match may start at, leftmost first, until one
 * matches or the subject's steps are spent.
 */
const backtrack = (machine: Backtracker, subject: string, check: MatchCheck): boolean => {
  const budget: Budget = { steps: 0, nextCheck: CHECK_INTERVAL, check };
  for (let from = firstStart(machine, subject); from !== NOWHERE; ) {
    const outcome = attempt(machine, subject, from, budget);
    if (outcome !== 'failed') return outcome === 'matched';
    from = nextStart(machine, subject, from);
  }
  return false;
};

const firstStart = ({ leading }: Backtracker, subject: string): number =>
  leading === undefined ? 0 : nextLeading(leading, subject, 0);

const nextStart = (machine: Backtracker, subject: string, from: number): number => {
  const code = subject.codePointAt(from);
  if (machine.starts === 'subject-start' || code === undefined) return NOWHERE;
  const after = from + (code < SURROGATE_PAIR ? 1 : 2);
  return machine.leading === undefined ? after : nextLeading(machine.leading, subject, after);
};

/** Follows one path from `from`, backing up to the last fork whenever it fails. */
const attempt = (machine: Backtracker, subject: string, from: number, budget: Budget): Outcome => {
  const { path, program } = machine;
  Object.assign(path, { pc: START, at: from });
  path.memory.fill(UNSET);
  path.trail.length = 0;
  path.choices.length = 0;
  for (;;) {
    if (program.ops[path.pc] === MATCH) return 'matched';
    if (!spend(budget)) return 'exhausted';
    if (!execute(machine, subject, budget) && !backUp(path)) return 'failed';
  }
};

/** Takes a step, consulting the check every interval; `false` once the budget is spent. */
const spend = (budget: Budget): boolean => {
  budget.steps += 1;
  if (budget.steps < budget.nextCheck) return true;
  budget.nextCheck += CHECK_INTERVAL;
  budget.check();
  return budget.steps < MAX_BACKTRACK_STEPS;
};

/** Returns to the last fork's other target, undoing the writes since; `false` where none is left. */
const backUp = (path: Path): boolean => {
  const { choices, trail, memory } = path;
  const length = choices.pop();
  if (length === undefined) return false;
  path.at = choices.pop() as number;
  path.pc = choices.pop() as number;
  while (trail.length > length) {
    const value = trail.pop() as number;
    memory[trail.pop() as number] = value;
  }
  return true;
};

const write = (path: Path, slot: number, value: number): void => {
  path.trail.push(slot, path.memory[slot] as number);
  path.memory[slot] = value;
};

/** Runs the instruction at the path's `pc`; `false` where the path fails there. */
type Executor = (machine: Backtracker, subject: string, budget: Budget) => boolean;

const readCharacter: Executor = ({ path, program }, subject) => {
  const code = subject.codePointAt(path.at);
  const charClass = program.classes[program.operand[path.pc] as number] as CharClass;
  if (code === undefined || !accepts(charClass, code, subject, path.at)) return false;
  path.at += code < SURROGATE_PAIR ? 1 : 2;
  path.pc += 1;
  return true;
};

const assertContext: Executor = (machine, subject) => {
  const { path, program } = machine;
  const context = contextAt(machine, subject, path.at);
  path.pc += 1;
  return (((program.operand[path.pc - 1] as number) >> context) & 1) === 1;
};

/** A fork to one target is a jump; any other leaves its second target to back up to. */
const branch: Executor = ({ path, program }) => {
  const to = program.operand[path.pc] as number;
  const or = program.target[path.pc] as number;
  if (to !== or) path.choices.push(or, path.at, path.trail.length);
  path.pc = to;
  return true;
};

const save: Executor = ({ path, program }) => {
  write(path, program.operand[path.pc] as number, path.at);
  path.pc += 1;
  return true;
};

/** A group no copy has captured reads nothing; each character compared is a step. */
const reread: Executor = ({ path, program }, subject, budget) => {
  const slot = (program.operand[path.pc] as number) * 2;
  const begin = path.memory[slot] as number;
  const end = path.memory[slot + 1] as number;
  if (end === UNSET) return false;
  const length = end - begin;
  const agreeing = repeated(subject, begin, begin + length, path.at);
  budget.steps += agreeing;
  if (agreeing !== length) return false;
  path.at += length;
  path.pc += 1;
  return true;
};

/** How many code units from `at` repeat those from `begin` up to `end`. */
const repeated = (subject: string, begin: number, end: number, at: number): number => {
  let count = 0;
  while (
    begin + count < end &&
    subject.charCodeAt(begin + count) === subject.charCodeAt(at + count)
  ) {
    count += 1;
  }
  return count;
};

/** The jump back to the repetition's fork follows the copy; a copy that read nothing steps past it. */
const progress: Executor = ({ path, program }) => {
  const empty = path.memory[program.operand[path.pc] as number] === path.at;
  path.pc += empty ? PAST_JUMP_BACK : 1;
  return true;
};

/** MATCH ends the run before an instruction is executed. */
const execute = (machine: Backtracker, subject: string, budget: Budget): boolean => {
  switch (machine.program.ops[machine.path.pc]) {
    case CHAR:
      return readCharacter(machine, subject, budget);
    case FORK:
      return branch(machine, subject, budget);
    case ASSERT:
      return assertContext(machine, subject, budget);
    case SAVE:
      return save(machine, subject, budget);
    case BACKREF:
      return reread(machine, subject, budget);
    default:
      return progress(machine, subject, budget);
  }
};

const contextAt = (layout: Layout, subject: string, at: number): Context =>
  (at === 0 ? AT_START : 0) |
  (at === subject.length ? AT_END : 0) |
  (isWordBefore(layout, subject, at) ? WORD_BEFORE : 0) |
  (isWord(layout, subject, at) ? WORD_AFTER : 0);

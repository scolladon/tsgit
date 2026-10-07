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
 * linear in the subject; one with back-references needs backtracking and runs
 * as its ECMAScript translation, exponential at worst — as regexec is there.
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
const WORD_CHARACTERS = '\\p{L}\\p{N}_';
const WORD = `[${WORD_CHARACTERS}]`;
const WORD_PATTERN = new RegExp(WORD, 'u');
const WORD_START = `(?<!${WORD})(?=${WORD})`;
const WORD_END = `(?<=${WORD})(?!${WORD})`;
const FLAGS = 'su';

/** Whether a zero-width assertion holds between the characters around a position. */
type Assertion = (before: string | undefined, after: string | undefined) => boolean;

const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD_PATTERN.test(ch);

/** An automaton step; `fork` targets are relative to the fork, a jump forks twice to one target. */
type Instruction =
  | { readonly op: 'char'; readonly matches: (character: string) => boolean }
  | { readonly op: 'assert'; readonly holds: Assertion }
  | { readonly op: 'fork'; readonly to: number; readonly or: number };

/** Instructions laid out in order without copying: repeated parts are shared. */
interface Sequence {
  readonly size: number;
  readonly parts: ReadonlyArray<Fragment>;
}

type Fragment = Instruction | Sequence;

/** A parsed expression: its ECMAScript source and its automaton. */
interface Piece {
  readonly source: string;
  readonly fragment: Fragment;
}

interface Bounds {
  readonly min: number;
  readonly max: number;
}

const anchor = (source: string, holds: Assertion): Piece => ({
  source,
  fragment: { op: 'assert', holds },
});

const SUBJECT_START = anchor('^', (before) => before === undefined);
const SUBJECT_END = anchor('$', (_before, after) => after === undefined);

const PLAIN_ANCHORS: ReadonlyMap<string, Piece> = new Map([
  ['^', SUBJECT_START],
  ['$', SUBJECT_END],
]);

const ESCAPED_ANCHORS: ReadonlyMap<string, Piece> = new Map([
  ['<', anchor(WORD_START, (before, after) => !isWord(before) && isWord(after))],
  ['>', anchor(WORD_END, (before, after) => isWord(before) && !isWord(after))],
  [
    'b',
    anchor(`(?:${WORD_START}|${WORD_END})`, (before, after) => isWord(before) !== isWord(after)),
  ],
  [
    'B',
    anchor(
      `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`,
      (before, after) => isWord(before) === isWord(after),
    ),
  ],
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

/** Parse position over the pattern's code points, with the groups already closed. */
interface Cursor {
  readonly chars: ReadonlyArray<string>;
  pos: number;
  groups: number;
  readonly closedGroups: Set<number>;
  backreferences: boolean;
}

/** A bracket member; `codePoint` is set only where it may bound a range. */
interface BracketMember {
  readonly source: string;
  readonly codePoint?: number;
}

type Translation = Piece | undefined;

export interface ExtendedRegex {
  /** Whether `subject` holds a match. */
  readonly test: (subject: string) => boolean;
}

export const compileExtendedRegex = (pattern: string): ExtendedRegex | undefined => {
  const cursor: Cursor = {
    chars: Array.from(pattern),
    pos: 0,
    groups: 0,
    closedGroups: new Set(),
    backreferences: false,
  };
  const piece = parseAlternation(cursor, 0);
  if (piece === undefined) return undefined;
  if (cursor.backreferences) return new RegExp(piece.source, FLAGS);
  return sizeOf(piece.fragment) > MAX_PROGRAM_SIZE ? undefined : automaton(piece.fragment);
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
const characterPiece = (source: string): Piece => {
  const pattern = new RegExp(source, FLAGS);
  return { source, fragment: { op: 'char', matches: (character) => pattern.test(character) } };
};

const literalPiece = (ch: string): Piece => ({
  source: literal(ch),
  fragment: { op: 'char', matches: (character) => character === ch },
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

const alternatePieces = (branches: ReadonlyArray<Piece>): Piece => ({
  source: branches.map((branch) => branch.source).join('|'),
  fragment: alternate(branches.map((branch) => branch.fragment)),
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
    source: pieces.map((piece) => piece.source).join(''),
    fragment: sequence(pieces.map((piece) => piece.fragment)),
  };
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
  return { source: `(${inner.source})`, fragment: inner.fragment };
};

/** A trailing `\` is refused. */
const parseEscape = (c: Cursor): Translation => {
  const ch = next(c);
  if (ch === undefined) return undefined;
  if (BACKREFERENCE.test(ch)) return parseBackreference(c, ch);
  const escapedClass = ESCAPED_CLASSES.get(ch);
  return escapedClass === undefined ? literalPiece(ch) : characterPiece(escapedClass);
};

/** A back-reference must name a group already closed; the pattern then needs backtracking. */
const parseBackreference = (c: Cursor, digit: string): Translation => {
  if (!c.closedGroups.has(Number(digit))) return undefined;
  c.backreferences = true;
  return { source: `(?:\\${digit})`, fragment: EMPTY };
};

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
    pending = outer === undefined ? undefined : stackRepetition(pending, outer);
  }
  if (pending?.bounds === undefined) return pending?.piece;
  return repeat(pending.piece, pending.bounds);
};

/** Folds `outer` into the pending repetition where the two make one, so stacks stay shallow. */
const stackRepetition = (
  { piece, bounds }: PendingRepetition,
  outer: Bounds,
): PendingRepetition | undefined => {
  if (bounds === undefined) return { piece, bounds: outer };
  if (absorbs(bounds)) return { piece, bounds: product(bounds, outer) };
  const repeated = repeat(piece, bounds);
  return repeated === undefined ? undefined : { piece: repeated, bounds: outer };
};

/** `R{a,b}{c,d}` is `R{ac,bd}` when the inner repetition is `*`, `+`, `?`, `{0}` or `{1}`. */
const absorbs = (inner: Bounds): boolean =>
  inner.min <= 1 && (inner.max <= 1 || inner.max === Number.POSITIVE_INFINITY);

const product = (inner: Bounds, outer: Bounds): Bounds => ({
  min: inner.min * outer.min,
  max: inner.max === 0 || outer.max === 0 ? 0 : inner.max * outer.max,
});

const repeat = (piece: Piece, bounds: Bounds): Translation => {
  const fragment = repeatFragment(piece.fragment, bounds);
  if (fragment === undefined) return undefined;
  const { min, max } = bounds;
  return {
    source: `(?:${piece.source}){${min},${max === Number.POSITIVE_INFINITY ? '' : max}}`,
    fragment,
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

const EMPTY: Sequence = { size: 0, parts: [] };
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

/**
 * `min` copies of `body`, then a skippable copy jumping back to its fork or
 * `max - min` skippable copies; every copy is shared. An empty body repeats
 * to itself, at no cost however large the bounds; copies that alone outgrow
 * the automaton are refused before they are laid out.
 */
const repeatFragment = (body: Fragment, { min, max }: Bounds): Fragment | undefined => {
  const size = sizeOf(body);
  if (size === 0) return body;
  if (size * (max === Number.POSITIVE_INFINITY ? min : max) > MAX_PROGRAM_SIZE) return undefined;
  const copies = Array<Fragment>(min).fill(body);
  const rest =
    max === Number.POSITIVE_INFINITY
      ? [fork(1, size + 2), body, fork(-size - 1, -size - 1)]
      : Array<Fragment>(max - min).fill(sequence([fork(1, size + 1), body]));
  return sequence([...copies, ...rest]);
};

const automaton = (fragment: Fragment): ExtendedRegex => {
  const program: Instruction[] = [];
  flatten(fragment, program);
  return { test: (subject) => run(program, subject) };
};

const flatten = (fragment: Fragment, program: Instruction[]): void => {
  if (!('parts' in fragment)) {
    program.push(fragment);
    return;
  }
  for (const part of fragment.parts) flatten(part, program);
};

/** A simulation over a program: the step at which each instruction last joined the threads. */
interface Simulation {
  readonly program: ReadonlyArray<Instruction>;
  readonly characters: ReadonlyArray<string>;
  readonly joined: Int32Array;
}

/** Threads start at every position and step together, one code point at a time. */
const run = (program: ReadonlyArray<Instruction>, subject: string): boolean => {
  const characters = Array.from(subject);
  const simulation = { program, characters, joined: new Int32Array(program.length).fill(-1) };
  let pending = [START];
  for (let at = 0; ; at += 1) {
    const ready = follow(simulation, pending, at);
    if (ready.includes(program.length)) return true;
    const character = characters[at];
    if (character === undefined) return false;
    pending = advance(program, ready, character);
  }
};

type CharInstruction = Extract<Instruction, { readonly op: 'char' }>;

/** The ready threads that consume `character`, one step on, and a thread starting afresh. */
const advance = (
  program: ReadonlyArray<Instruction>,
  ready: ReadonlyArray<number>,
  character: string,
): number[] => {
  const pending = [START];
  for (const pc of ready) {
    if ((program[pc] as CharInstruction).matches(character)) pending.push(pc + 1);
  }
  return pending;
};

/**
 * Drains `pending` through forks and holding assertions, each instruction
 * once per step, into the threads ready at a character or at the match.
 */
const follow = (simulation: Simulation, pending: number[], at: number): number[] => {
  const { program, characters, joined } = simulation;
  const ready: number[] = [];
  for (let pc = pending.pop(); pc !== undefined; pc = pending.pop()) {
    if (joined[pc] === at) continue;
    joined[pc] = at;
    const instruction = program[pc];
    if (instruction === undefined || instruction.op === 'char') ready.push(pc);
    else if (instruction.op === 'fork') pending.push(pc + instruction.to, pc + instruction.or);
    else if (instruction.holds(characters[at - 1], characters[at])) pending.push(pc + 1);
  }
  return ready;
};

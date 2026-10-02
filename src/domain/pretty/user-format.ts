import { concatBytes } from '../objects/encoding.js';
import type { CommitView } from './commit-view.js';
import { splitIdentLine } from './ident.js';
import { formatSanitizedSubject, formatSubject } from './subject.js';

export type AbbrevKind = 'commit' | 'tree' | 'parents';

export interface Ident {
  readonly name: Uint8Array;
  readonly mail: Uint8Array;
}

/** Resolved data a format may read; each member is only consulted when a placeholder asks. */
export interface FormatEnv {
  readonly commitId: string;
  readonly abbrev: (kind: AbbrevKind) => string;
  readonly mapUser?: (ident: Ident) => Ident;
}

export interface FormatBudget {
  readonly describe: 0 | 1;
}

export type Magic = 'none' | 'lf-before' | 'del-lf' | 'sp-before';

type IdentLetter = 'a' | 'c';
type IdentPart = 'n' | 'N' | 'e' | 'E' | 'l' | 'L' | 't' | 'd' | 'D' | 'r' | 'i' | 'I' | 's' | 'h';
type MessagePart = 'subject' | 'sanitized' | 'body' | 'full' | 'encoding';

type IdentSpec = {
  readonly kind: 'ident';
  readonly letter: IdentLetter;
  readonly part: IdentPart;
};

type Spec =
  | { readonly kind: 'literal'; readonly bytes: Uint8Array }
  | { readonly kind: 'declined'; readonly parsesHeader: boolean }
  | { readonly kind: 'refused'; readonly placeholder: FormatRefusal['refused'] }
  | { readonly kind: 'id'; readonly of: AbbrevKind }
  | { readonly kind: 'abbrev'; readonly of: AbbrevKind }
  | IdentSpec
  | { readonly kind: 'message'; readonly part: MessagePart };

export type Token =
  | { readonly kind: 'text'; readonly bytes: Uint8Array }
  | { readonly kind: 'item'; readonly magic: Magic; readonly spec: Spec };

export interface FormatOutput {
  readonly bytes: Uint8Array;
  readonly budget: FormatBudget;
  readonly parsedHeader: boolean;
}

export interface FormatRefusal {
  readonly refused: '%(count)' | '%(total)';
}

const PERCENT = 0x25;
const PLUS = 0x2b;
const MINUS = 0x2d;
const SPACE = 0x20;
const LINE_FEED = 0x0a;
const AT_SIGN = 0x40;
const LOWER_W = 0x77;
const HEX_RADIX = 16;
const HEX_PAIR_LENGTH = 2;
const PAIR_LENGTH = 2;
const NO_BYTES = new Uint8Array();
const MERGE_MARK = Uint8Array.of(0x3e);

const MAGIC_BY_BYTE: ReadonlyMap<number, Magic> = new Map([
  [PLUS, 'lf-before'],
  [MINUS, 'del-lf'],
  [SPACE, 'sp-before'],
]);

const HEX_DIGIT = /^[0-9a-fA-F]{2}$/;
const IDENT_PARTS = 'nNeElLtdDriIsh';
const REFLOG_PARTS = 'dDnNeEs';
const MAPPED_IDENT_PARTS = 'NEL';
const BLANK_WHEN_MALFORMED_PARTS = 'n e t d D r i';
const REFUSALS = ['(count)', '(total)'] as const;
const UNPARSED_PAREN_PREFIXES = ['(decorate', '(describe'];

const hexByte = (fmt: Uint8Array, at: number): number | undefined => {
  const pair = new TextDecoder('latin1').decode(fmt.subarray(at, at + HEX_PAIR_LENGTH));
  return HEX_DIGIT.test(pair) ? Number.parseInt(pair, HEX_RADIX) : undefined;
};

const declined = (parsesHeader: boolean): Spec => ({ kind: 'declined', parsesHeader });

interface Classified {
  readonly spec: Spec;
  readonly length: number;
}

const DECLINED_PARSING: Classified = { spec: declined(true), length: 0 };
const DECLINED_UNPARSED: Classified = { spec: declined(false), length: 0 };
const one = (spec: Spec): Classified => ({ spec, length: 1 });
const literal = (bytes: Uint8Array): Spec => ({ kind: 'literal', bytes });

const SINGLE_BYTE_SPECS: ReadonlyMap<string, Classified> = new Map([
  ['n', one(literal(Uint8Array.of(LINE_FEED)))],
  ['H', one({ kind: 'id', of: 'commit' })],
  ['T', one({ kind: 'id', of: 'tree' })],
  ['P', one({ kind: 'id', of: 'parents' })],
  ['h', one({ kind: 'abbrev', of: 'commit' })],
  ['t', one({ kind: 'abbrev', of: 'tree' })],
  ['p', one({ kind: 'abbrev', of: 'parents' })],
  ['m', one(literal(MERGE_MARK))],
  ['s', one({ kind: 'message', part: 'subject' })],
  ['f', one({ kind: 'message', part: 'sanitized' })],
  ['b', one({ kind: 'message', part: 'body' })],
  ['B', one({ kind: 'message', part: 'full' })],
  ['e', one({ kind: 'message', part: 'encoding' })],
  ...[...'SNCw<>dDG'].map((letter): [string, Classified] => [letter, DECLINED_UNPARSED]),
]);

const classifyHex = (fmt: Uint8Array, at: number): Classified => {
  const byte = hexByte(fmt, at + 1);
  if (byte === undefined) return DECLINED_PARSING;
  return { spec: literal(Uint8Array.of(byte)), length: 1 + HEX_PAIR_LENGTH };
};

const classifyIdent = (letter: IdentLetter, fmt: Uint8Array, at: number): Classified => {
  const part = String.fromCharCode(fmt[at + 1] as number);
  if (!IDENT_PARTS.includes(part)) return DECLINED_PARSING;
  return { spec: { kind: 'ident', letter, part: part as IdentPart }, length: PAIR_LENGTH };
};

const classifyReflog = (fmt: Uint8Array, at: number): Classified => {
  const part = String.fromCharCode(fmt[at + 1] as number);
  if (!REFLOG_PARTS.includes(part)) return DECLINED_UNPARSED;
  return { spec: literal(NO_BYTES), length: PAIR_LENGTH };
};

const startsWithAt = (fmt: Uint8Array, at: number, prefix: string): boolean =>
  prefix.length <= fmt.length - at &&
  [...prefix].every((letter, offset) => fmt[at + offset] === letter.charCodeAt(0));

const classifyParen = (fmt: Uint8Array, at: number): Classified => {
  const refusal = REFUSALS.find((candidate) => startsWithAt(fmt, at, candidate));
  if (refusal) {
    return { spec: { kind: 'refused', placeholder: `%${refusal}` }, length: refusal.length };
  }
  return UNPARSED_PAREN_PREFIXES.some((prefix) => startsWithAt(fmt, at, prefix))
    ? DECLINED_UNPARSED
    : DECLINED_PARSING;
};

const classify = (fmt: Uint8Array, at: number): Classified => {
  const letter = String.fromCharCode(fmt[at] as number);
  const single = SINGLE_BYTE_SPECS.get(letter);
  if (single) return single;
  if (letter === 'x') return classifyHex(fmt, at);
  if (letter === 'a' || letter === 'c') return classifyIdent(letter, fmt, at);
  if (letter === 'g') return classifyReflog(fmt, at);
  return letter === '(' ? classifyParen(fmt, at) : DECLINED_PARSING;
};

interface Scanned {
  readonly token: Token;
  readonly next: number;
}

const text = (bytes: Uint8Array): Token => ({ kind: 'text', bytes });

const scanAfterPercent = (fmt: Uint8Array, at: number): Scanned => {
  if (fmt[at] === PERCENT) return { token: text(Uint8Array.of(PERCENT)), next: at + 1 };
  const magic = MAGIC_BY_BYTE.get(fmt[at] as number) ?? 'none';
  const itemAt = magic === 'none' ? at : at + 1;
  const { spec, length } = classify(fmt, itemAt);
  if (magic !== 'none' && fmt[itemAt] === LOWER_W)
    return { token: { kind: 'item', magic: 'none', spec }, next: at };
  return { token: { kind: 'item', magic, spec }, next: itemAt + length };
};

export const scanPlaceholders = (fmt: Uint8Array): ReadonlyArray<Token> => {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < fmt.length) {
    const percent = fmt.indexOf(PERCENT, cursor);
    if (percent === -1) {
      tokens.push(text(fmt.subarray(cursor)));
      break;
    }
    if (percent > cursor) tokens.push(text(fmt.subarray(cursor, percent)));
    const { token, next } = scanAfterPercent(fmt, percent + 1);
    tokens.push(token);
    cursor = next;
  }
  return tokens;
};

const trimTrailingLineFeeds = (pieces: Uint8Array[]): void => {
  while (pieces.length > 0) {
    const last = pieces[pieces.length - 1] as Uint8Array;
    let end = last.length;
    while (end > 0 && last[end - 1] === LINE_FEED) end--;
    if (end > 0) {
      pieces[pieces.length - 1] = last.subarray(0, end);
      return;
    }
    pieces.pop();
  }
};

const magicPrefix = (magic: Magic): Uint8Array =>
  magic === 'lf-before' ? Uint8Array.of(LINE_FEED) : Uint8Array.of(SPACE);

const pushDeclined = (pieces: Uint8Array[], magic: Magic, source: Uint8Array): void => {
  if (magic === 'del-lf') trimTrailingLineFeeds(pieces);
  pieces.push(magic === 'none' ? concatBytes([Uint8Array.of(PERCENT), source]) : source);
};

const pushValue = (pieces: Uint8Array[], magic: Magic, value: Uint8Array): void => {
  if (value.length === 0 && magic === 'del-lf') trimTrailingLineFeeds(pieces);
  if (value.length > 0 && (magic === 'lf-before' || magic === 'sp-before'))
    pieces.push(magicPrefix(magic));
  pieces.push(value);
};

const identLine = (spec: IdentSpec, view: CommitView): Uint8Array =>
  (spec.letter === 'a' ? view.author : view.committer) ?? NO_BYTES;

const localPart = (mail: Uint8Array): Uint8Array => {
  const at = mail.indexOf(AT_SIGN);
  return at === -1 ? mail : mail.subarray(0, at);
};

const mapIdent = (part: IdentPart, ident: Ident, env: FormatEnv): Ident =>
  MAPPED_IDENT_PARTS.includes(part) ? (env.mapUser?.(ident) ?? ident) : ident;

const blankOrDeclined = (part: IdentPart): Uint8Array | undefined =>
  BLANK_WHEN_MALFORMED_PARTS.includes(part) ? NO_BYTES : undefined;

const evalIdent = (spec: IdentSpec, view: CommitView, env: FormatEnv): Uint8Array | undefined => {
  const { name, mail, date } = splitIdentLine(identLine(spec, view));
  if (!name || !mail) return blankOrDeclined(spec.part);
  const mapped = mapIdent(spec.part, { name, mail }, env);
  if ('nN'.includes(spec.part)) return mapped.name;
  if ('eE'.includes(spec.part)) return mapped.mail;
  if ('lL'.includes(spec.part)) return localPart(mapped.mail);
  if (!date) return blankOrDeclined(spec.part);
  return spec.part === 't' ? date : undefined;
};

const evalMessage = (part: MessagePart, view: CommitView): Uint8Array => {
  switch (part) {
    case 'subject':
      return formatSubject(view.subject);
    case 'sanitized':
      return formatSanitizedSubject(view.subject);
    case 'body':
      return view.body;
    case 'full':
      return view.message;
    case 'encoding':
      return view.encoding ?? NO_BYTES;
  }
};

const encodeAscii = (text: string): Uint8Array => new TextEncoder().encode(text);

const fullId = (of: AbbrevKind, view: CommitView, env: FormatEnv): string => {
  if (of === 'commit') return env.commitId;
  return of === 'tree' ? (view.tree ?? '') : view.parents.join(' ');
};

const evalSpec = (spec: Spec, view: CommitView, env: FormatEnv): Uint8Array | undefined => {
  switch (spec.kind) {
    case 'literal':
      return spec.bytes;
    case 'id':
      return encodeAscii(fullId(spec.of, view, env));
    case 'abbrev':
      return encodeAscii(env.abbrev(spec.of));
    case 'ident':
      return evalIdent(spec, view, env);
    case 'message':
      return evalMessage(spec.part, view);
    default:
      return undefined;
  }
};

const declinedSource = (spec: Spec): Uint8Array =>
  spec.kind === 'ident' ? encodeAscii(`${spec.letter}${spec.part}`) : NO_BYTES;

const parsesHeader = (spec: Spec): boolean =>
  spec.kind === 'ident' ||
  spec.kind === 'message' ||
  (spec.kind === 'declined' && spec.parsesHeader);

export const formatCommit = (
  tokens: ReadonlyArray<Token>,
  view: CommitView,
  env: FormatEnv,
  budget: FormatBudget,
): FormatOutput | FormatRefusal => {
  const pieces: Uint8Array[] = [];
  let parsedHeader = false;
  for (const token of tokens) {
    if (token.kind === 'text') {
      pieces.push(token.bytes);
      continue;
    }
    if (token.spec.kind === 'refused') return { refused: token.spec.placeholder };
    parsedHeader ||= parsesHeader(token.spec);
    const value = evalSpec(token.spec, view, env);
    if (value === undefined) pushDeclined(pieces, token.magic, declinedSource(token.spec));
    else pushValue(pieces, token.magic, value);
  }
  return { bytes: concatBytes(pieces), budget, parsedHeader };
};

export interface FormatRequirements {
  readonly abbrev: ReadonlySet<AbbrevKind>;
  readonly mailmap: boolean;
}

const itemSpecs = (tokens: ReadonlyArray<Token>): ReadonlyArray<Spec> =>
  tokens.flatMap((token) => (token.kind === 'item' ? [token.spec] : []));

/** What `formatCommit` will read from the environment, from the same tokens it expands. */
export const formatRequirements = (tokens: ReadonlyArray<Token>): FormatRequirements => {
  const specs = itemSpecs(tokens);
  return {
    abbrev: new Set(specs.flatMap((spec) => (spec.kind === 'abbrev' ? [spec.of] : []))),
    mailmap: specs.some((spec) => spec.kind === 'ident' && MAPPED_IDENT_PARTS.includes(spec.part)),
  };
};

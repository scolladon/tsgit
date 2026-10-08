import { concatBytes } from '../objects/encoding.js';
import { parseColorPlaceholder } from './color.js';
import { type CommitView, skipBlankLines } from './commit-view.js';
import {
  type Decoration,
  type DecorationOptions,
  formatDecorations,
  parseDecoratePlaceholder,
} from './decorations.js';
import {
  DESCRIBE_PREFIX,
  type DescribeArgs,
  parseDescribePlaceholder,
} from './describe-placeholder.js';
import { splitIdentLine } from './ident.js';
import { DATE_MODE_BY_PART, type DateClock, showIdentDate } from './ident-date.js';
import { type PadRequest, padValue, parsePadding, type Truncation } from './padding.js';
import { utf8View } from './reencode.js';
import { formatSanitizedSubject, formatSubject } from './subject.js';
import {
  formatTrailers,
  parseTrailersPlaceholder,
  type TrailerConfig,
  type TrailerOptions,
} from './trailers.js';
import {
  NO_WRAPPING,
  parseWrapLayout,
  rewrapTail,
  type WrapLayout,
  type Wrapping,
} from './wrap.js';

export type AbbrevKind = 'commit' | 'tree' | 'parents';

export interface Ident {
  readonly name: Uint8Array;
  readonly mail: Uint8Array;
}

/** git's `signature_check`, as the `%G` placeholders read it. */
export interface SignatureCheck {
  readonly result: 'G' | 'B' | 'E' | 'X' | 'Y' | 'R' | 'N';
  readonly trust: 'undefined' | 'never' | 'marginal' | 'fully' | 'ultimate';
  readonly signer: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly primaryKeyFingerprint: string;
  readonly output: string;
}

/** Resolved data a format may read; each member is only consulted when a placeholder asks. */
export interface FormatEnv extends DateClock {
  readonly commitId: string;
  readonly abbrev: (kind: AbbrevKind) => string;
  readonly mapUser?: (ident: Ident) => Ident;
  readonly trailer?: TrailerConfig;
  readonly decorations?: ReadonlyArray<Decoration>;
  /** The describe run's output for the one placeholder that spent the budget. */
  readonly describe?: string;
  /** Absent for an unsigned commit. */
  readonly signature?: SignatureCheck;
}

export interface FormatBudget {
  readonly describe: 0 | 1;
}

export type Magic = 'none' | 'lf-before' | 'del-lf' | 'sp-before';

type IdentLetter = 'a' | 'c';
type IdentPart = 'n' | 'N' | 'e' | 'E' | 'l' | 'L' | 't' | 'd' | 'D' | 'r' | 'i' | 'I' | 's' | 'h';
type MessagePart = 'subject' | 'sanitized' | 'body' | 'full' | 'encoding';
type SignaturePart = '?' | 'G' | 'S' | 'K' | 'F' | 'P' | 'T';

type IdentSpec = {
  readonly kind: 'ident';
  readonly letter: IdentLetter;
  readonly part: IdentPart;
};

type Spec =
  | { readonly kind: 'literal'; readonly bytes: Uint8Array }
  | { readonly kind: 'color'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'padding';
      readonly request: PadRequest;
      readonly truncate: Truncation | undefined;
      readonly literal: boolean;
    }
  | { readonly kind: 'declined'; readonly parsesHeader: boolean }
  | { readonly kind: 'refused'; readonly placeholder: FormatRefusal['refused'] }
  | { readonly kind: 'id'; readonly of: AbbrevKind }
  | { readonly kind: 'abbrev'; readonly of: AbbrevKind }
  | IdentSpec
  | { readonly kind: 'wrap'; readonly layout: WrapLayout }
  | { readonly kind: 'message'; readonly part: MessagePart }
  | { readonly kind: 'trailers'; readonly options: TrailerOptions }
  | { readonly kind: 'decorations'; readonly options: DecorationOptions }
  | { readonly kind: 'describe'; readonly args: DescribeArgs | undefined }
  | { readonly kind: 'signature'; readonly part: SignaturePart };

export type Token =
  | { readonly kind: 'text'; readonly bytes: Uint8Array }
  | { readonly kind: 'item'; readonly magic: Magic; readonly spec: Spec };

export interface FormatOutput {
  readonly bytes: Uint8Array;
  readonly budget: FormatBudget;
  readonly parsedHeader: boolean;
}

/** Placeholders git dies on: `%C` stands for an unparsable `%C(always,…)` spec. */
export interface FormatRefusal {
  readonly refused: '%(count)' | '%(total)' | '%C';
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
const UNPARSED_PAREN_PREFIXES: ReadonlyArray<string> = ['(decorate'];
const SIGNATURE_PARTS: ReadonlyArray<string> = ['?', 'G', 'S', 'K', 'F', 'P', 'T'];
const SPENT: FormatBudget = { describe: 0 };
const UNVERIFIED: SignatureCheck = {
  result: 'N',
  trust: 'undefined',
  signer: '',
  key: '',
  fingerprint: '',
  primaryKeyFingerprint: '',
  output: '',
};
const NO_AFFIXES: DecorationOptions = { prefix: NO_BYTES, suffix: NO_BYTES };

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
  ['d', one({ kind: 'decorations', options: {} })],
  ['D', one({ kind: 'decorations', options: NO_AFFIXES })],
  ['s', one({ kind: 'message', part: 'subject' })],
  ['f', one({ kind: 'message', part: 'sanitized' })],
  ['b', one({ kind: 'message', part: 'body' })],
  ['B', one({ kind: 'message', part: 'full' })],
  ['e', one({ kind: 'message', part: 'encoding' })],
  ...[...'SN'].map((letter): [string, Classified] => [letter, DECLINED_UNPARSED]),
]);

const classifyHex = (fmt: Uint8Array, at: number): Classified => {
  const byte = hexByte(fmt, at + 1);
  if (byte === undefined) return DECLINED_PARSING;
  return { spec: literal(Uint8Array.of(byte)), length: 1 + HEX_PAIR_LENGTH };
};

const classifyColor = (fmt: Uint8Array, at: number): Classified => {
  const parsed = parseColorPlaceholder(fmt, at);
  if (!parsed) return DECLINED_UNPARSED;
  if ('unparsable' in parsed) return { spec: { kind: 'refused', placeholder: '%C' }, length: 0 };
  return { spec: { kind: 'color', bytes: parsed.bytes }, length: parsed.length };
};

const classifyPadding = (fmt: Uint8Array, at: number): Classified => {
  const parsed = parsePadding(fmt, at);
  if (!parsed) return DECLINED_UNPARSED;
  const { request, truncate, length } = parsed;
  return { spec: { kind: 'padding', request, truncate, literal: length === 0 }, length };
};

const classifyWrap = (fmt: Uint8Array, at: number): Classified => {
  const parsed = parseWrapLayout(fmt, at);
  if (!parsed) return DECLINED_UNPARSED;
  return { spec: { kind: 'wrap', layout: parsed.layout }, length: parsed.length };
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

const classifySignature = (fmt: Uint8Array, at: number): Classified => {
  const part = String.fromCharCode(fmt[at + 1] as number);
  if (!SIGNATURE_PARTS.includes(part)) return DECLINED_UNPARSED;
  return { spec: { kind: 'signature', part: part as SignaturePart }, length: PAIR_LENGTH };
};

/** git spends the describe budget on the prefix alone, before reading the arguments. */
const classifyDescribe = (fmt: Uint8Array, at: number, budget: FormatBudget): Classified => {
  if (budget.describe === 0) return DECLINED_UNPARSED;
  const parsed = parseDescribePlaceholder(fmt, at);
  if (!parsed) return { spec: { kind: 'describe', args: undefined }, length: 0 };
  return { spec: { kind: 'describe', args: parsed.args }, length: parsed.length };
};

const startsWithAt = (fmt: Uint8Array, at: number, prefix: string): boolean =>
  prefix.length <= fmt.length - at &&
  [...prefix].every((letter, offset) => fmt[at + offset] === letter.charCodeAt(0));

const classifyParen = (fmt: Uint8Array, at: number, budget: FormatBudget): Classified => {
  const refusal = REFUSALS.find((candidate) => startsWithAt(fmt, at, candidate));
  if (refusal) {
    return { spec: { kind: 'refused', placeholder: `%${refusal}` }, length: refusal.length };
  }
  if (startsWithAt(fmt, at, DESCRIBE_PREFIX)) return classifyDescribe(fmt, at, budget);
  const decorate = parseDecoratePlaceholder(fmt, at);
  if (decorate)
    return { spec: { kind: 'decorations', options: decorate.options }, length: decorate.length };
  const trailers = parseTrailersPlaceholder(fmt, at);
  if (trailers)
    return { spec: { kind: 'trailers', options: trailers.options }, length: trailers.length };
  return UNPARSED_PAREN_PREFIXES.some((prefix) => startsWithAt(fmt, at, prefix))
    ? DECLINED_UNPARSED
    : DECLINED_PARSING;
};

const classify = (fmt: Uint8Array, at: number, budget: FormatBudget): Classified => {
  const letter = String.fromCharCode(fmt[at] as number);
  const single = SINGLE_BYTE_SPECS.get(letter);
  if (single) return single;
  if (letter === 'x') return classifyHex(fmt, at);
  if (letter === 'C') return classifyColor(fmt, at);
  if (letter === 'w') return classifyWrap(fmt, at);
  if (letter === '<' || letter === '>') return classifyPadding(fmt, at);
  if (letter === 'a' || letter === 'c') return classifyIdent(letter, fmt, at);
  if (letter === 'g') return classifyReflog(fmt, at);
  if (letter === 'G') return classifySignature(fmt, at);
  return letter === '(' ? classifyParen(fmt, at, budget) : DECLINED_PARSING;
};

interface Scanned {
  readonly token: Token;
  readonly next: number;
}

const text = (bytes: Uint8Array): Token => ({ kind: 'text', bytes });

const scanAfterPercent = (fmt: Uint8Array, at: number, budget: FormatBudget): Scanned => {
  if (fmt[at] === PERCENT) return { token: text(Uint8Array.of(PERCENT)), next: at + 1 };
  const magic = MAGIC_BY_BYTE.get(fmt[at] as number) ?? 'none';
  const itemAt = magic === 'none' ? at : at + 1;
  if (magic !== 'none' && fmt[itemAt] === LOWER_W)
    return { token: { kind: 'item', magic: 'none', spec: DECLINED_UNPARSED.spec }, next: at };
  const { spec, length } = classify(fmt, itemAt, budget);
  return { token: { kind: 'item', magic, spec }, next: itemAt + length };
};

/** Tokenizes `fmt`; only the first `%(describe` may spend an available `budget`. */
export const scanPlaceholders = (
  fmt: Uint8Array,
  budget: FormatBudget = SPENT,
): ReadonlyArray<Token> => {
  const tokens: Token[] = [];
  let remaining = budget;
  let cursor = 0;
  while (cursor < fmt.length) {
    const percent = fmt.indexOf(PERCENT, cursor);
    if (percent === -1) {
      tokens.push(text(fmt.subarray(cursor)));
      break;
    }
    if (percent > cursor) tokens.push(text(fmt.subarray(cursor, percent)));
    const { token, next } = scanAfterPercent(fmt, percent + 1, remaining);
    if (spendsDescribe(token)) remaining = SPENT;
    tokens.push(token);
    cursor = next;
  }
  return tokens;
};

const spendsDescribe = (token: Token): boolean =>
  token.kind === 'item' && token.spec.kind === 'describe';

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

const evalIdentDate = (
  part: IdentPart,
  date: Uint8Array,
  tz: Uint8Array,
  env: FormatEnv,
): Uint8Array | undefined => {
  if (part === 't') return date;
  const mode = DATE_MODE_BY_PART.get(part);
  return mode && encodeAscii(showIdentDate(date, tz, mode, env));
};

const evalIdent = (spec: IdentSpec, view: CommitView, env: FormatEnv): Uint8Array | undefined => {
  const { name, mail, date, tz } = splitIdentLine(identLine(spec, view));
  if (!name || !mail) return blankOrDeclined(spec.part);
  const mapped = mapIdent(spec.part, { name, mail }, env);
  if ('nN'.includes(spec.part)) return mapped.name;
  if ('eE'.includes(spec.part)) return mapped.mail;
  if ('lL'.includes(spec.part)) return localPart(mapped.mail);
  if (!date || !tz) return blankOrDeclined(spec.part);
  return evalIdentDate(spec.part, date, tz, env);
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

/** git prints `U` for a good signature whose key it does not trust. */
const signatureStatus = ({ result, trust }: SignatureCheck): string =>
  result === 'G' && (trust === 'undefined' || trust === 'never') ? 'U' : result;

const SIGNATURE_FIELDS: Readonly<Record<SignaturePart, (check: SignatureCheck) => string>> = {
  '?': signatureStatus,
  G: (check) => check.output,
  S: (check) => check.signer,
  K: (check) => check.key,
  F: (check) => check.fingerprint,
  P: (check) => check.primaryKeyFingerprint,
  T: (check) => check.trust,
};

const evalSignature = (part: SignaturePart, env: FormatEnv): Uint8Array =>
  encodeUtf8(SIGNATURE_FIELDS[part](env.signature ?? UNVERIFIED));

const evalDescribe = (args: DescribeArgs | undefined, env: FormatEnv): Uint8Array | undefined =>
  args === undefined ? undefined : encodeUtf8(env.describe ?? '');

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const evalSpec = (spec: Spec, view: CommitView, env: FormatEnv): Uint8Array | undefined => {
  switch (spec.kind) {
    case 'literal':
    case 'color':
      return spec.bytes;
    case 'wrap':
      return NO_BYTES;
    case 'padding':
      return spec.literal ? undefined : NO_BYTES;
    default:
      return evalCommitSpec(spec, view, env);
  }
};

/** A placeholder that reads the commit, or the environment it is shown in. */
const evalCommitSpec = (spec: Spec, view: CommitView, env: FormatEnv): Uint8Array | undefined => {
  switch (spec.kind) {
    case 'id':
      return encodeAscii(fullId(spec.of, view, env));
    case 'abbrev':
      return encodeAscii(env.abbrev(spec.of));
    case 'ident':
      return evalIdent(spec, view, env);
    case 'message':
      return evalMessage(spec.part, view);
    case 'trailers':
      return evalTrailers(spec.options, view, env);
    default:
      return evalEnvironmentSpec(spec, env);
  }
};

/** A placeholder that reads only the environment the commit is shown in. */
const evalEnvironmentSpec = (spec: Spec, env: FormatEnv): Uint8Array | undefined => {
  switch (spec.kind) {
    case 'decorations':
      return formatDecorations(env.decorations ?? [], spec.options);
    case 'describe':
      return evalDescribe(spec.args, env);
    case 'signature':
      return evalSignature(spec.part, env);
    default:
      return undefined;
  }
};

const evalTrailers = (
  options: Extract<Spec, { readonly kind: 'trailers' }>['options'],
  view: CommitView,
  env: FormatEnv,
): Uint8Array =>
  formatTrailers(view.message.subarray(skipBlankLines(view.message, 0)), options, env.trailer);

const declinedSource = (spec: Spec): Uint8Array =>
  spec.kind === 'ident' ? encodeAscii(`${spec.letter}${spec.part}`) : NO_BYTES;

const parsesHeader = (spec: Spec): boolean =>
  spec.kind === 'ident' ||
  spec.kind === 'message' ||
  spec.kind === 'trailers' ||
  (spec.kind === 'declined' && spec.parsesHeader);

type ItemToken = Extract<Token, { kind: 'item' }>;

interface Layout {
  readonly wrapping: Wrapping;
  readonly pad: PadRequest | undefined;
  readonly truncate: Truncation;
}

interface Step {
  readonly layout: Layout;
  readonly consumed: number;
}

const START_LAYOUT: Layout = { wrapping: NO_WRAPPING, pad: undefined, truncate: 'none' };

const appendPlain = (pieces: Uint8Array[], item: ItemToken, view: CommitView, env: FormatEnv) => {
  const value = evalSpec(item.spec, view, env);
  if (value === undefined) pushDeclined(pieces, item.magic, declinedSource(item.spec));
  else pushValue(pieces, item.magic, value);
};

const isColor = (token: Token | undefined): boolean =>
  token?.kind === 'item' && token.spec.kind === 'color';

/** git pads colour modifiers together with the placeholder that follows them. */
const paddedUnit = (tokens: ReadonlyArray<Token>, at: number): ItemToken[] => {
  let end = at;
  while (isColor(tokens[end]) && tokens[end + 1]?.kind === 'item') end++;
  return tokens.slice(at, end + 1) as ItemToken[];
};

const appendPadded = (
  pieces: Uint8Array[],
  request: PadRequest,
  truncate: Truncation,
  unit: ReadonlyArray<ItemToken>,
  context: { readonly view: CommitView; readonly env: FormatEnv },
): void => {
  const [first, last] = [unit[0] as ItemToken, unit[unit.length - 1] as ItemToken];
  const values = unit.map(({ spec }) => evalSpec(spec, context.view, context.env) ?? NO_BYTES);
  const { head, body } = padValue(concatBytes(pieces), concatBytes(values), request, truncate);
  pieces.splice(0, pieces.length, head);
  pushValue(pieces, first.magic, body);
  if (evalSpec(last.spec, context.view, context.env) !== undefined) return;
  if (unit.length === 1) pushDeclined(pieces, first.magic, declinedSource(last.spec));
  else pieces.push(declinedSource(last.spec));
};

const armPadding = (layout: Layout, spec: Spec): Layout =>
  spec.kind === 'padding'
    ? { ...layout, pad: spec.request, truncate: spec.truncate ?? layout.truncate }
    : layout;

const appendToken = (
  pieces: Uint8Array[],
  layout: Layout,
  tokens: ReadonlyArray<Token>,
  at: number,
  context: { readonly view: CommitView; readonly env: FormatEnv },
): Step => {
  const item = tokens[at] as Token;
  if (item.kind === 'text') {
    pieces.push(item.bytes);
    return { layout, consumed: 1 };
  }
  const wrapping =
    item.spec.kind === 'wrap'
      ? rewrapTail(pieces, layout.wrapping, item.spec.layout)
      : layout.wrapping;
  const armed = armPadding({ ...layout, wrapping }, item.spec);
  if (layout.pad === undefined) {
    appendPlain(pieces, item, context.view, context.env);
    return { layout: armed, consumed: 1 };
  }
  const unit = paddedUnit(tokens, at);
  const align = item.spec.kind === 'padding' ? item.spec.request.align : layout.pad.align;
  const request = { ...layout.pad, align };
  appendPadded(pieces, request, armed.truncate, unit, context);
  return { layout: { ...armed, pad: undefined }, consumed: unit.length };
};

const firstRefusal = (tokens: ReadonlyArray<Token>): FormatRefusal | undefined => {
  for (const token of tokens) {
    if (token.kind === 'item' && token.spec.kind === 'refused') {
      return { refused: token.spec.placeholder };
    }
  }
  return undefined;
};

/**
 * Expands `tokens` after `accumulated` — the output so far, which git's magic, column and
 * wrap placeholders see — and returns the whole buffer.
 */
export const formatCommit = (
  tokens: ReadonlyArray<Token>,
  rawView: CommitView,
  env: FormatEnv,
  budget: FormatBudget,
  accumulated: Uint8Array = NO_BYTES,
): FormatOutput | FormatRefusal => {
  const refusal = firstRefusal(tokens);
  if (refusal) return refusal;
  const view = utf8View(rawView);
  const pieces: Uint8Array[] = [accumulated];
  let layout: Layout = { ...START_LAYOUT, wrapping: { ...NO_WRAPPING, start: accumulated.length } };
  let at = 0;
  while (at < tokens.length) {
    const step = appendToken(pieces, layout, tokens, at, { view, env });
    layout = step.layout;
    at += step.consumed;
  }
  rewrapTail(pieces, layout.wrapping, NO_WRAPPING.layout);
  const parsedHeader = itemSpecs(tokens).some(parsesHeader);
  const remaining = tokens.some(spendsDescribe) ? SPENT : budget;
  return { bytes: concatBytes(pieces), budget: remaining, parsedHeader };
};

/** The placeholder that spent the describe budget; `args` is absent when git declines it. */
export interface DescribeRequirement {
  readonly args: DescribeArgs | undefined;
}

export interface FormatRequirements {
  readonly abbrev: ReadonlySet<AbbrevKind>;
  readonly mailmap: boolean;
  readonly decorations: boolean;
  readonly signature: boolean;
  readonly describe: DescribeRequirement | undefined;
  /** git dies at the refusing placeholder, so nothing after it is ever read. */
  readonly refuses: boolean;
}

const itemSpecs = (tokens: ReadonlyArray<Token>): ReadonlyArray<Spec> =>
  tokens.flatMap((token) => (token.kind === 'item' ? [token.spec] : []));

const describeRequirement = (specs: ReadonlyArray<Spec>): DescribeRequirement | undefined => {
  const spec = specs.find((candidate) => candidate.kind === 'describe');
  return spec?.kind === 'describe' ? { args: spec.args } : undefined;
};

/** What `formatCommit` will read from the environment, from the same tokens it expands. */
export const formatRequirements = (tokens: ReadonlyArray<Token>): FormatRequirements => {
  const all = itemSpecs(tokens);
  const refusal = all.findIndex((spec) => spec.kind === 'refused');
  const specs = refusal === -1 ? all : all.slice(0, refusal);
  return {
    refuses: refusal !== -1,
    abbrev: new Set(specs.flatMap((spec) => (spec.kind === 'abbrev' ? [spec.of] : []))),
    mailmap: specs.some((spec) => spec.kind === 'ident' && MAPPED_IDENT_PARTS.includes(spec.part)),
    decorations: specs.some((spec) => spec.kind === 'decorations'),
    signature: specs.some((spec) => spec.kind === 'signature'),
    describe: describeRequirement(specs),
  };
};

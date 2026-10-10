import { isAsciiSpace } from './ascii.js';

export interface TrailerConfig {
  readonly separators?: string;
  /** Canonical key by configured token name (as written; matched case-insensitively). */
  readonly keys?: ReadonlyMap<string, string>;
}

export interface TrailerOptions {
  readonly onlyTrailers: boolean;
  readonly unfold: boolean;
  readonly keyOnly: boolean;
  readonly valueOnly: boolean;
  readonly separator?: string;
  readonly keyValueSeparator?: string;
  /** Keys to keep; empty keeps every trailer. */
  readonly keys: ReadonlyArray<string>;
}

export const DEFAULT_TRAILER_OPTIONS: TrailerOptions = {
  onlyTrailers: false,
  unfold: false,
  keyOnly: false,
  valueOnly: false,
  keys: [],
};

const LINE_FEED = '\n';
const COMMENT = '#';
const DEFAULT_SEPARATORS = ':';
const GENERATED_PREFIXES: ReadonlyArray<string> = [
  'Signed-off-by: ',
  '(cherry picked from commit ',
];
const CUT_LINE = '# ------------------------ >8 ------------------------\n';
const OLD_CONFLICTS = 'Conflicts:\n';
const TRAILER_RATIO = 3;
const LATIN1_CHUNK = 8_192;

/** `TextDecoder('latin1')` is windows-1252 in the Encoding Standard; this maps each byte to one code unit. */
const toByteString = (bytes: Uint8Array): string => {
  let text = '';
  // Stryker disable next-line EqualityOperator: equivalent — at === bytes.length appends String.fromCharCode() of an empty subarray, i.e. ''
  for (let at = 0; at < bytes.length; at += LATIN1_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(at, at + LATIN1_CHUNK));
  }
  return text;
};

const fromByteString = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));

/** False past either end of `text` (`charCodeAt` is NaN there), which bounds every whitespace walk. */
const isSpaceAt = (text: string, at: number): boolean => isAsciiSpace(text.charCodeAt(at));

const nextLine = (text: string, from: number): number => {
  const feed = text.indexOf(LINE_FEED, from);
  return feed === -1 ? text.length : feed + 1;
};

/** Start of the line ending at `length`; its own line feed belongs to it. */
const lastLine = (text: string, length: number): number => {
  if (length === 0) return -1;
  if (length === 1) return 0;
  const feed = text.lastIndexOf(LINE_FEED, length - 2);
  return feed + 1;
};

const isBlankLine = (text: string, at: number): boolean => {
  let cursor = at;
  while (text[cursor] !== LINE_FEED && isSpaceAt(text, cursor)) cursor++;
  return cursor === text.length || text[cursor] === LINE_FEED;
};

const isCommentLine = (text: string, at: number): boolean => text.startsWith(COMMENT, at);

const isAlphanumeric = (char: string): boolean => /^[A-Za-z0-9]$/.test(char);

const isTokenChar = (char: string): boolean => char === '-' || isAlphanumeric(char);

/** `find_separator`: position of the separator after an optional token and whitespace, else -1. */
const findSeparator = (line: string, separators: string): number => {
  let whitespaceFound = false;
  for (let at = 0; at < line.length; at++) {
    const char = line.charAt(at);
    if (separators.includes(char)) return at;
    if (!whitespaceFound && isTokenChar(char)) continue;
    if (at > 0 && (char === ' ' || char === '\t')) {
      whitespaceFound = true;
      continue;
    }
    return -1;
  }
  return -1;
};

const cutLineStart = (text: string): number => {
  if (text.startsWith(CUT_LINE)) return 0;
  const found = text.indexOf(`${LINE_FEED}${CUT_LINE}`);
  return found === -1 ? text.length : found + 1;
};

/** `ignored_log_message_bytes`: trailing comments, blank lines, old conflict lists and cut lines. */
const endOfLogMessage = (text: string): number => {
  const cutoff = cutLineStart(text);
  let commentStart = 0;
  let inConflicts = false;
  for (let line = 0; line < cutoff; line = nextLine(text, line)) {
    if (isCommentLine(text, line) || text[line] === LINE_FEED) {
      commentStart ||= line;
    } else if (text.startsWith(OLD_CONFLICTS, line)) {
      inConflicts = true;
      commentStart ||= line;
    } else if (commentStart && !(inConflicts && text[line] === '\t')) {
      commentStart = 0;
      inConflicts = false;
    }
  }
  return commentStart ? commentStart : cutoff;
};

/** `strncasecmp(token, name, length) == 0`; a name shorter than `length` slices short and never matches. */
const sameStart = (token: string, name: string, length: number): boolean =>
  token.slice(0, length).toLowerCase() === name.slice(0, length).toLowerCase();

const namesConfiguredToken = (line: string, length: number, keys: ReadonlyMap<string, string>) =>
  [...keys].some(([name, key]) => sameStart(line, name, length) || sameStart(line, key, length));

interface Tally {
  readonly onlySpaces: boolean;
  readonly recognized: boolean;
  readonly trailers: number;
  readonly plain: number;
  readonly continuations: number;
}

const START_TALLY: Tally = {
  onlySpaces: true,
  recognized: false,
  trailers: 0,
  plain: 0,
  continuations: 0,
};

interface Grammar {
  readonly separators: string;
  readonly keys: ReadonlyMap<string, string>;
}

const countLine = (tally: Tally, line: string, grammar: Grammar): Tally => {
  const counted = { ...tally, onlySpaces: false };
  if (GENERATED_PREFIXES.some((prefix) => line.startsWith(prefix))) {
    return { ...counted, trailers: tally.trailers + 1, continuations: 0, recognized: true };
  }
  const separator = findSeparator(line, grammar.separators);
  if (separator >= 1 && !isSpaceAt(line, 0)) {
    const recognized = tally.recognized || namesConfiguredToken(line, separator, grammar.keys);
    return { ...counted, trailers: tally.trailers + 1, continuations: 0, recognized };
  }
  if (isSpaceAt(line, 0)) return { ...counted, continuations: tally.continuations + 1 };
  return { ...counted, plain: tally.plain + tally.continuations + 1, continuations: 0 };
};

const closesBlock = (tally: Tally): boolean => {
  const plain = tally.plain + tally.continuations;
  if (tally.recognized && tally.trailers * TRAILER_RATIO >= plain) return true;
  // git also asks for a trailer line, but a counted paragraph with no plain line always holds one.
  return plain === 0;
};

/** `find_trailer_block_start`: offset of the first trailer line, or `length` when there is none. */
const trailerBlockStart = (text: string, grammar: Grammar): number => {
  // git stops at the end of the title; the title holds no blank line, so scanning it can only fall through to `text.length`.
  let tally = START_TALLY;
  for (let line = lastLine(text, text.length); line >= 0; line = lastLine(text, line)) {
    if (isCommentLine(text, line)) {
      tally = { ...tally, plain: tally.plain + tally.continuations, continuations: 0 };
    } else if (!isBlankLine(text, line)) {
      tally = countLine(tally, text.slice(line), grammar);
    } else if (!tally.onlySpaces) {
      return closesBlock(tally) ? nextLine(text, line) : text.length;
    }
  }
  return text.length;
};

interface Block {
  readonly start: number;
  readonly end: number;
}

interface Item {
  readonly token: string | undefined;
  readonly value: string;
}

const locateBlock = (whole: string, grammar: Grammar): Block => {
  const end = endOfLogMessage(whole);
  const text = whole.slice(0, end);
  return { start: trailerBlockStart(text, grammar), end };
};

/** Lines of the block; an indented line continues the trailer above it. */
const blockEntries = (block: string, separators: string): string[] => {
  const entries: string[] = [];
  let continuable = false;
  for (let at = 0; at < block.length; at = nextLine(block, at)) {
    const line = block.slice(at, nextLine(block, at));
    if (continuable && isSpaceAt(line, 0)) {
      entries[entries.length - 1] += line;
      continue;
    }
    entries.push(line);
    continuable = findSeparator(line, separators) >= 1;
  }
  return entries;
};

const trim = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (isSpaceAt(text, start)) start++;
  while (isSpaceAt(text, end - 1)) end--;
  return text.slice(start, end);
};

const unfoldValue = (value: string): string => trim(value.replace(/\n[ \t\n\v\f\r]*/g, ' '));

const tokenLength = (token: string): number => {
  let length = token.length;
  while (length > 0 && !isAlphanumeric(token[length - 1] as string)) length--;
  return length;
};

const canonicalToken = (token: string, keys: ReadonlyMap<string, string>): string => {
  const length = tokenLength(token);
  const configured = [...keys].find(
    ([name, key]) => sameStart(token, name, length) || sameStart(token, key, length),
  );
  return configured ? configured[1] : token;
};

const parseEntry = (entry: string, options: TrailerOptions, grammar: Grammar): Item | undefined => {
  if (isCommentLine(entry, 0)) return undefined;
  const separator = findSeparator(entry, grammar.separators);
  if (separator < 1) {
    return options.onlyTrailers ? undefined : { token: undefined, value: entry.replace(/\n$/, '') };
  }
  const value = trim(entry.slice(separator + 1));
  return {
    token: canonicalToken(trim(entry.slice(0, separator)), grammar.keys),
    value: options.unfold ? unfoldValue(value) : value,
  };
};

/** An empty last character (no token text) is "included" in every string, so it yields no glue. */
const keyValueGlue = (token: string, options: TrailerOptions, separators: string): string => {
  if (options.keyValueSeparator !== undefined) return options.keyValueSeparator;
  return separators.includes(token.slice(-1)) ? '' : `${separators[0]} `;
};

const matchesKeys = (token: string, keys: ReadonlyArray<string>): boolean =>
  keys.length === 0 ||
  keys.some((key) => key.length === token.length && sameStart(token, key, key.length));

const renderTrailer = (
  token: string,
  value: string,
  options: TrailerOptions,
  separators: string,
): string => {
  const key = options.valueOnly ? '' : token;
  const glue = options.keyOnly || options.valueOnly ? '' : keyValueGlue(token, options, separators);
  return `${key}${glue}${options.keyOnly ? '' : value}`;
};

const renderItem = (
  item: Item,
  options: TrailerOptions,
  separators: string,
): string | undefined => {
  if (item.token === undefined) return item.value;
  if (!matchesKeys(item.token, options.keys)) return undefined;
  return renderTrailer(item.token, item.value, options, separators);
};

const hasFilters = (options: TrailerOptions): boolean =>
  options.onlyTrailers ||
  options.unfold ||
  options.keyOnly ||
  options.valueOnly ||
  options.keys.length > 0 ||
  options.separator !== undefined ||
  options.keyValueSeparator !== undefined;

const joinRendered = (rendered: ReadonlyArray<string>, separator: string | undefined): string =>
  separator === undefined
    ? rendered.map((piece) => `${piece}${LINE_FEED}`).join('')
    : rendered.join(separator);

export const formatTrailers = (
  message: Uint8Array,
  options: TrailerOptions,
  config: TrailerConfig = {},
): Uint8Array => {
  const whole = toByteString(message);
  const separators = config.separators ?? DEFAULT_SEPARATORS;
  const grammar = { separators, keys: config.keys ?? new Map() };
  const { start, end } = locateBlock(whole, grammar);
  const block = whole.slice(start, end);
  if (!hasFilters(options)) return fromByteString(block);
  const rendered = blockEntries(block, separators)
    .map((entry) => parseEntry(entry, options, grammar))
    .map((item) => item && renderItem(item, options, separators))
    .filter((piece): piece is string => piece !== undefined);
  return fromByteString(joinRendered(rendered, options.separator));
};

export interface TrailersPlaceholder {
  readonly options: TrailerOptions;
  readonly length: number;
}

const OPEN = '(trailers';
const OPTIONS_START = ':';
const CLOSE = ')';
const OPTION_BREAK = /[,)]/;
const SEPARATOR_ESCAPE = /%(?:(%)|(n)|x([0-9a-fA-F]{2}))/g;
const HEX_RADIX = 16;
const TRUE_WORDS = ['true', 'yes', 'on'];
const FALSE_WORDS = ['false', 'no', 'off', ''];
const INTEGER_VALUE = /^\s*[+-]?(\d+)[kmg]?$/i;
const BOOLEAN_OPTIONS = [
  ['only', 'onlyTrailers'],
  ['unfold', 'unfold'],
  ['keyonly', 'keyOnly'],
  ['valueonly', 'valueOnly'],
] as const;

interface Matched {
  readonly value: string | undefined;
  /** Where the next option starts, or at the closing parenthesis. */
  readonly end: number;
}

/** An unterminated value ends at `source.length`, where no option name matches, so the list is still rejected. */
const closeOption = (source: string, end: number, value: string | undefined): Matched => ({
  value,
  end: source[end] === ',' ? end + 1 : end,
});

const valueEnd = (source: string, from: number): number => {
  const found = source.slice(from).search(OPTION_BREAK);
  // Stryker disable next-line ConditionalExpression: equivalent — `from - 1` is the '=' sign, where no option name matches either, so the list is rejected the same way
  return found === -1 ? source.length : from + found;
};

/** `match_placeholder_arg_value`: `name` or `name=value`, then `,` (consumed) or `)` (left). */
const matchOption = (source: string, at: number, name: string): Matched | undefined => {
  if (!source.startsWith(name, at)) return undefined;
  const afterName = at + name.length;
  if (source[afterName] !== '=') {
    return OPTION_BREAK.test(source.charAt(afterName))
      ? closeOption(source, afterName, undefined)
      : undefined;
  }
  // Stryker disable next-line ArithmeticOperator: equivalent — searching from the name's last character adds it and '=', neither of which is ',' or ')'
  const end = valueEnd(source, afterName + 1);
  return closeOption(source, end, source.slice(afterName + 1, end));
};

const parseBoolean = (text: string): boolean | undefined => {
  const lowered = text.toLowerCase();
  if (TRUE_WORDS.includes(lowered)) return true;
  if (FALSE_WORDS.includes(lowered)) return false;
  const integer = INTEGER_VALUE.exec(text);
  return integer ? BigInt(integer[1] as string) !== 0n : undefined;
};

const expandSeparator = (raw: string): string =>
  raw.replace(SEPARATOR_ESCAPE, (_escape, percent, feed, hex) =>
    percent ? '%' : feed ? LINE_FEED : String.fromCharCode(Number.parseInt(hex, HEX_RADIX)),
  );

interface Parsed {
  readonly options: TrailerOptions;
  readonly at: number;
}

const parseKey = (matched: Matched, options: TrailerOptions): Parsed | undefined => {
  if (matched.value === undefined) return undefined;
  const key = matched.value.replace(/:$/, '');
  return {
    options: { ...options, onlyTrailers: true, keys: [...options.keys, key] },
    at: matched.end,
  };
};

const parseText = (
  source: string,
  at: number,
  options: TrailerOptions,
  name: 'separator' | 'keyValueSeparator',
): Parsed | undefined => {
  const matched = matchOption(
    source,
    at,
    name === 'separator' ? 'separator' : 'key_value_separator',
  );
  if (matched === undefined) return undefined;
  return { options: { ...options, [name]: expandSeparator(matched.value ?? '') }, at: matched.end };
};

/**
 * git probes the boolean names in turn; a value that is not a boolean still consumes its
 * option, so the next name is probed from the text after it.
 */
const parseBooleans = (
  source: string,
  from: number,
  options: TrailerOptions,
): Parsed | undefined => {
  let at = from;
  for (const [name, flag] of BOOLEAN_OPTIONS) {
    const matched = matchOption(source, at, name);
    if (matched === undefined) continue;
    const value = matched.value === undefined ? true : parseBoolean(matched.value);
    if (value !== undefined) return { options: { ...options, [flag]: value }, at: matched.end };
    at = matched.end;
  }
  return undefined;
};

const parseOption = (source: string, at: number, options: TrailerOptions): Parsed | undefined => {
  const key = matchOption(source, at, 'key');
  if (key !== undefined) return parseKey(key, options);
  return (
    parseText(source, at, options, 'separator') ??
    parseText(source, at, options, 'keyValueSeparator') ??
    parseBooleans(source, at, options)
  );
};

const parseOptionList = (source: string, from: number): Parsed | undefined => {
  let parsed: Parsed = { options: DEFAULT_TRAILER_OPTIONS, at: from };
  while (source[parsed.at] !== CLOSE) {
    const next = parseOption(source, parsed.at, parsed.options);
    if (next === undefined) return undefined;
    parsed = next;
  }
  return parsed;
};

/** `%(trailers[:option,…])` at `at` (the opening parenthesis); `undefined` when git leaves it literal. */
export const parseTrailersPlaceholder = (
  fmt: Uint8Array,
  at: number,
): TrailersPlaceholder | undefined => {
  const source = toByteString(fmt.subarray(at));
  if (!source.startsWith(OPEN)) return undefined;
  const listStart = source.startsWith(OPTIONS_START, OPEN.length) ? OPEN.length + 1 : OPEN.length;
  const parsed = parseOptionList(source, listStart);
  return parsed && { options: parsed.options, length: parsed.at + 1 };
};

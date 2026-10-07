const ESCAPE = '\x1b';
const BACKGROUND_OFFSET = 10;
const FOREGROUND_ANSI = 30;
const BRIGHT_ANSI = 90;
const DEFAULT_ANSI = 39;
const EXTENDED = 38;
const FIRST_BRIGHT = 8;
const FIRST_EXTENDED = 16;
const PALETTE_SIZE = 256;
const SHORT_HEX_LENGTH = 4;
const LONG_HEX_LENGTH = 7;
const CHANNELS = 3;
const NIBBLE = 16;
const BRIGHT_PREFIX = 'bright';
const C_SPACES = /[ \t\n\v\f\r]+/;

/** Renders one colour as SGR parameters; `offset` moves it from foreground to background. */
type Color = (offset: number) => string;

const ANSI_NAMES: ReadonlyArray<string> = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

const ATTRIBUTES: ReadonlyMap<string, { readonly on: number; readonly off: number }> = new Map([
  ['bold', { on: 1, off: 22 }],
  ['dim', { on: 2, off: 22 }],
  ['italic', { on: 3, off: 23 }],
  ['ul', { on: 4, off: 24 }],
  ['blink', { on: 5, off: 25 }],
  ['reverse', { on: 7, off: 27 }],
  ['strike', { on: 9, off: 29 }],
]);

const NO_COLOR: Color = () => '';
const ansi =
  (code: number): Color =>
  (offset) =>
    String(code + offset);
const palette =
  (index: number): Color =>
  (offset) =>
    `${EXTENDED + offset};5;${index}`;
const rgb =
  (red: number, green: number, blue: number): Color =>
  (offset) =>
    `${EXTENDED + offset};2;${red};${green};${blue}`;

const parseAnsiName = (word: string): Color | undefined => {
  if (word === 'default') return ansi(DEFAULT_ANSI);
  const bright = word.startsWith(BRIGHT_PREFIX);
  const index = ANSI_NAMES.indexOf(bright ? word.slice(BRIGHT_PREFIX.length) : word);
  if (index === -1) return undefined;
  return ansi((bright ? BRIGHT_ANSI : FOREGROUND_ANSI) + index);
};

const parseHex = (word: string): Color | undefined => {
  if (word.length !== SHORT_HEX_LENGTH && word.length !== LONG_HEX_LENGTH) return undefined;
  const digits = word.slice(1);
  const width = digits.length / CHANNELS;
  const channels = [0, 1, 2].map((at) => digits.slice(at * width, (at + 1) * width));
  if (!channels.every((channel) => /^[0-9a-f]+$/.test(channel))) return undefined;
  const [red, green, blue] = channels.map((channel) =>
    Number.parseInt(width === 1 ? channel.repeat(2) : channel, NIBBLE),
  ) as [number, number, number];
  return rgb(red, green, blue);
};

const parseNumber = (word: string): Color | undefined => {
  if (!/^[+-]?\d+$/.test(word)) return undefined;
  const value = Number(word);
  if (value === -1) return NO_COLOR;
  if (value < 0 || value >= PALETTE_SIZE) return undefined;
  if (value < FIRST_BRIGHT) return ansi(FOREGROUND_ANSI + value);
  if (value < FIRST_EXTENDED) return ansi(BRIGHT_ANSI + value - FIRST_BRIGHT);
  return palette(value);
};

const parseColor = (word: string): Color | undefined => {
  if (word === 'normal') return NO_COLOR;
  return (
    (word.startsWith('#') ? parseHex(word) : undefined) ?? parseAnsiName(word) ?? parseNumber(word)
  );
};

const parseAttribute = (word: string): number | undefined => {
  const negated = word.startsWith('no');
  const attribute = ATTRIBUTES.get(negated ? word.replace(/^no-?/, '') : word);
  return attribute && (negated ? attribute.off : attribute.on);
};

interface Parsed {
  readonly reset: boolean;
  readonly attributes: ReadonlySet<number>;
  readonly foreground?: Color;
  readonly background?: Color;
}

const parseWord = (parsed: Parsed, word: string): Parsed | undefined => {
  if (word === 'reset') return { ...parsed, reset: true };
  const color = parseColor(word);
  if (color && !parsed.foreground) return { ...parsed, foreground: color };
  if (color && !parsed.background) return { ...parsed, background: color };
  if (color) return undefined;
  const attribute = parseAttribute(word);
  if (attribute === undefined) return undefined;
  return { ...parsed, attributes: new Set([...parsed.attributes, attribute]) };
};

const renderColor = (color: Color | undefined, offset: number): string[] => {
  const parameter = color?.(offset) ?? '';
  return parameter === '' ? [] : [parameter];
};

// A lone reset still counts as one (empty) parameter, hence the leading ';' before what follows.
const render = ({ reset, attributes, foreground, background }: Parsed): string => {
  const parameters = [
    ...(reset ? [''] : []),
    ...[...attributes].sort((a, b) => a - b).map(String),
    ...renderColor(foreground, 0),
    ...renderColor(background, BACKGROUND_OFFSET),
  ];
  return parameters.length === 0 ? '' : `${ESCAPE}[${parameters.join(';')}m`;
};

/** git's `color_parse_mem`: the escape for `spec`, '' when it selects nothing, `undefined` when invalid. */
export const parseColorSpec = (spec: string): string | undefined => {
  let parsed: Parsed | undefined = { reset: false, attributes: new Set() };
  for (const word of spec.toLowerCase().split(C_SPACES).filter(Boolean)) {
    parsed = parseWord(parsed, word);
    if (!parsed) return undefined;
  }
  return render(parsed);
};

const LEFT_PAREN = 0x28;
const RIGHT_PAREN = 0x29;
const ALWAYS_PREFIX = 'always,';
const BASIC_NAMES: ReadonlyArray<string> = ['red', 'green', 'blue', 'reset'];
const NO_BYTES = new Uint8Array();

export interface ParsedColorPlaceholder {
  readonly bytes: Uint8Array;
  readonly length: number;
}

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** An `always` spec git cannot parse: it dies rather than leaving the placeholder literal. */
export const UNPARSABLE_COLOR = { unparsable: true } as const;
export type UnparsableColor = typeof UNPARSABLE_COLOR;

const parseParenthesised = (
  fmt: Uint8Array,
  at: number,
): ParsedColorPlaceholder | UnparsableColor | undefined => {
  const close = fmt.indexOf(RIGHT_PAREN, at + 2);
  if (close === -1) return undefined;
  const argument = latin1(fmt.subarray(at + 2, close));
  const length = close - at + 1;
  if (!argument.startsWith(ALWAYS_PREFIX)) return { bytes: NO_BYTES, length };
  const sequence = parseColorSpec(argument.slice(ALWAYS_PREFIX.length));
  return sequence === undefined
    ? UNPARSABLE_COLOR
    : { bytes: new TextEncoder().encode(sequence), length };
};

/**
 * `%C…` as archive context expands it, `at` being the `C`: colour is never wanted, so only
 * `%C(always,…)` emits; `undefined` when git leaves the placeholder literal, and
 * `UNPARSABLE_COLOR` for an `always` spec git cannot parse (it aborts).
 */
export const parseColorPlaceholder = (
  fmt: Uint8Array,
  at: number,
): ParsedColorPlaceholder | UnparsableColor | undefined => {
  if (fmt[at + 1] === LEFT_PAREN) return parseParenthesised(fmt, at);
  const name = BASIC_NAMES.find(
    (candidate) => latin1(fmt.subarray(at + 1, at + 1 + candidate.length)) === candidate,
  );
  return name === undefined ? undefined : { bytes: NO_BYTES, length: 1 + name.length };
};

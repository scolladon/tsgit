const NUL = 0x00;
const NEWLINE = 0x0a;
const COMMENT = 0x23;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const DIGIT_ZERO = 0x30;
const OCTAL_RADIX = 8;
const OCTAL_ESCAPE_LENGTH = 3;
const MAX_FIRST_OCTAL_DIGIT = 3;
const MAX_OCTAL_DIGIT = 7;

const SIMPLE_ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x61, 0x07], // \a
  [0x62, 0x08], // \b
  [0x66, 0x0c], // \f
  [0x6e, NEWLINE], // \n
  [0x72, 0x0d], // \r
  [0x74, 0x09], // \t
  [0x76, 0x0b], // \v
  [BACKSLASH, BACKSLASH],
  [QUOTE, QUOTE],
]);

export interface Unquoted {
  readonly value: Uint8Array;
  readonly end: number;
}

const octalDigit = (byte: number | undefined, max: number): number | undefined => {
  if (byte === undefined) return undefined;
  const digit = byte - DIGIT_ZERO;
  return digit >= 0 && digit <= max ? digit : undefined;
};

const readOctal = (bytes: Uint8Array, at: number): number | undefined => {
  let value = octalDigit(bytes[at], MAX_FIRST_OCTAL_DIGIT);
  for (let offset = 1; offset < OCTAL_ESCAPE_LENGTH && value !== undefined; offset++) {
    const digit = octalDigit(bytes[at + offset], MAX_OCTAL_DIGIT);
    value = digit === undefined ? undefined : value * OCTAL_RADIX + digit;
  }
  return value;
};

/** git's `unquote_c_style`: `bytes[start]` is the opening quote; `undefined` when the quoting is broken. */
export const unquoteCStyle = (bytes: Uint8Array, start: number): Unquoted | undefined => {
  const out: number[] = [];
  let at = start + 1;
  while (at < bytes.length) {
    const byte = bytes[at] as number;
    if (byte === QUOTE) return { value: new Uint8Array(out), end: at + 1 };
    if (byte !== BACKSLASH) {
      out.push(byte);
      at++;
      continue;
    }
    const escaped = bytes[at + 1];
    const simple = escaped === undefined ? undefined : SIMPLE_ESCAPES.get(escaped);
    if (simple !== undefined) {
      out.push(simple);
      at += 2;
      continue;
    }
    const octal = readOctal(bytes, at + 1);
    if (octal === undefined) return undefined;
    out.push(octal);
    at += 1 + OCTAL_ESCAPE_LENGTH;
  }
  return undefined;
};

const lineEnd = (bytes: Uint8Array, from: number): number => {
  const found = bytes.indexOf(NEWLINE, from);
  return found === -1 ? bytes.length : found;
};

/** git's `parse_alternates(buf, '\n', …)`: entries in file order, C-unquoted, never trimmed. */
export const parseAlternatesFile = (input: Uint8Array): ReadonlyArray<Uint8Array> => {
  const firstNul = input.indexOf(NUL);
  const bytes = firstNul === -1 ? input : input.subarray(0, firstNul);
  const entries: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (bytes[at] === COMMENT) {
      at = lineEnd(bytes, at) + 1;
      continue;
    }
    const unquoted = bytes[at] === QUOTE ? unquoteCStyle(bytes, at) : undefined;
    const end = unquoted?.end ?? lineEnd(bytes, at);
    const entry = unquoted?.value ?? bytes.subarray(at, end);
    if (entry.length > 0) entries.push(entry);
    at = end + 1;
  }
  return entries;
};

const HEX_TABLE: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += HEX_TABLE[byte];
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const high = parseHexDigit(hex.charCodeAt(i));
    const low = parseHexDigit(hex.charCodeAt(i + 1));
    if (high === -1 || low === -1) {
      throw new Error(`Invalid hex character at position ${i}`);
    }
    bytes[i / 2] = (high << 4) | low;
  }
  return bytes;
}

function parseHexDigit(charCode: number): number {
  if (charCode >= 48 && charCode <= 57) return charCode - 48;
  if (charCode >= 97 && charCode <= 102) return charCode - 87;
  return -1;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** Concatenates byte parts into one buffer. */
export function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Stryker disable next-line EqualityOperator: equivalent — lengths are equal here, so at i===a.length both a[i] and b[i] are undefined and undefined !== undefined is false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function indexOf(bytes: Uint8Array, target: number, fromIndex: number): number {
  // Stryker disable next-line EqualityOperator: equivalent — at i=bytes.length, bytes[i] is undefined; `undefined === target` is always false for a numeric target, so the extra iteration changes nothing.
  for (let i = fromIndex; i < bytes.length; i++) {
    if (bytes[i] === target) return i;
  }
  return -1;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encode(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

// Decodes UTF-8 bytes without treating a leading U+FEFF as decoder
// bookkeeping to strip: git stores commit/tag header and message bytes
// verbatim, so a byte-order mark that happens to open a message, an
// identity value, or a header line is content, not a stream marker. The
// commit/tag parse path decodes several independent byte sub-slices per
// object — a plain `decode()` call on each would treat that slice's start
// as a fresh stream start and silently drop a BOM sitting there.
const bomPreservingDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function decodePreservingBom(bytes: Uint8Array): string {
  return bomPreservingDecoder.decode(bytes);
}

// `text` must come from `decodePreservingBom(raw)`: that decoder emits U+FFFD
// only for an invalid sequence or a literal EF BF BD, and a valid decode
// re-encodes to the same bytes, so a view without U+FFFD is lossless without
// paying for an encode.
export function decodesLosslessly(text: string, raw: Uint8Array): boolean {
  return !text.includes('\uFFFD') || bytesEqual(encode(text), raw);
}

const ESCAPE_BASE = 0xdc00;
const ESCAPE_MIN = 0xdc80;
const ESCAPE_MAX = 0xdcff;
const ASCII_MAX = 0x7f;
const CONTINUATION_MIN = 0x80;
const CONTINUATION_MAX = 0xbf;
const TWO_BYTE_LEAD_MIN = 0xc2;
const TWO_BYTE_LEAD_MAX = 0xdf;
const THREE_BYTE_LEAD_MIN = 0xe0;
const THREE_BYTE_LEAD_MAX = 0xef;
const FOUR_BYTE_LEAD_MIN = 0xf0;
const FOUR_BYTE_LEAD_MAX = 0xf4;
const OVERLONG_THREE_LEAD = 0xe0;
const OVERLONG_THREE_SECOND_MIN = 0xa0;
const SURROGATE_LEAD = 0xed;
const SURROGATE_SECOND_MAX = 0x9f;
const OVERLONG_FOUR_LEAD = 0xf0;
const OVERLONG_FOUR_SECOND_MIN = 0x90;
const ABOVE_RANGE_LEAD = 0xf4;
const ABOVE_RANGE_SECOND_MAX = 0x8f;
const TWO = 2;
const THREE = 3;
const FOUR = 4;

const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= CONTINUATION_MIN && byte <= CONTINUATION_MAX;

const secondByteRange = (lead: number): readonly [number, number] => {
  if (lead === OVERLONG_THREE_LEAD) return [OVERLONG_THREE_SECOND_MIN, CONTINUATION_MAX];
  if (lead === SURROGATE_LEAD) return [CONTINUATION_MIN, SURROGATE_SECOND_MAX];
  if (lead === OVERLONG_FOUR_LEAD) return [OVERLONG_FOUR_SECOND_MIN, CONTINUATION_MAX];
  if (lead === ABOVE_RANGE_LEAD) return [CONTINUATION_MIN, ABOVE_RANGE_SECOND_MAX];
  return [CONTINUATION_MIN, CONTINUATION_MAX];
};

const expectedLength = (lead: number): number => {
  if (lead <= ASCII_MAX) return 1;
  if (lead >= TWO_BYTE_LEAD_MIN && lead <= TWO_BYTE_LEAD_MAX) return TWO;
  if (lead >= THREE_BYTE_LEAD_MIN && lead <= THREE_BYTE_LEAD_MAX) return THREE;
  if (lead >= FOUR_BYTE_LEAD_MIN && lead <= FOUR_BYTE_LEAD_MAX) return FOUR;
  return 0;
};

// Length of the well-formed UTF-8 sequence starting at `at` (Unicode Table 3-7), 0 when none does.
function wellFormedLengthAt(bytes: Uint8Array, at: number): number {
  const lead = bytes[at] as number;
  const length = expectedLength(lead);
  if (length <= 1) return length;
  const [min, max] = secondByteRange(lead);
  const second = bytes[at + 1];
  if (second === undefined || second < min || second > max) return 0;
  for (let i = TWO; i < length; i++) {
    if (!isContinuation(bytes[at + i])) return 0;
  }
  return length;
}

// Python's surrogate-escape error handler: each byte of a rejected sequence becomes the lone surrogate
// U+DC00 + byte, so the string keeps the bytes and stays injective.
export function decodeEscapingInvalid(bytes: Uint8Array): string {
  const view = decodePreservingBom(bytes);
  if (decodesLosslessly(view, bytes)) return view;
  let result = '';
  let runStart = 0;
  let at = 0;
  while (at < bytes.length) {
    const length = wellFormedLengthAt(bytes, at);
    if (length > 0) {
      at += length;
      continue;
    }
    result += decodePreservingBom(bytes.subarray(runStart, at));
    result += String.fromCharCode(ESCAPE_BASE + (bytes[at] as number));
    at++;
    runStart = at;
  }
  return result + decodePreservingBom(bytes.subarray(runStart));
}

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LONE_ESCAPE = /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/;

// A LONE low surrogate only: one that completes a pair is part of an astral character.
export function hasEscapedBytes(text: string): boolean {
  return LONE_ESCAPE.test(text);
}

const isHighSurrogate = (unit: number): boolean =>
  unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX;

// Inverse of `decodeEscapingInvalid`: a lone U+DC80..U+DCFF is its byte, the rest is UTF-8.
export function encodeEscaped(text: string): Uint8Array {
  if (!hasEscapedBytes(text)) return encode(text);
  const parts: Uint8Array[] = [];
  let runStart = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < ESCAPE_MIN || unit > ESCAPE_MAX) continue;
    if (i > 0 && isHighSurrogate(text.charCodeAt(i - 1))) continue;
    parts.push(encode(text.slice(runStart, i)), Uint8Array.of(unit - ESCAPE_BASE));
    runStart = i + 1;
  }
  parts.push(encode(text.slice(runStart)));
  return concatBytes(parts);
}

export function splitHeaderAndMessage(text: string): {
  readonly headerPart: string;
  readonly message: string;
} {
  const blankIndex = text.indexOf('\n\n');
  return blankIndex === -1
    ? { headerPart: text, message: '' }
    : { headerPart: text.slice(0, blankIndex), message: text.slice(blankIndex + 2) };
}

export function formatContinuationHeader(key: string, value: string): string {
  if (key.includes('\n') || key.includes(' ') || key === '') {
    throw new Error(`invalid header key: ${key}`);
  }
  const valueParts = value.split('\n');
  const first = `${key} ${valueParts[0]}`;
  const rest = valueParts.slice(1).map((line) => ` ${line}`);
  return [first, ...rest].join('\n');
}

export function parseHeaderLine(line: string): { readonly key: string; readonly value: string } {
  const spaceIdx = line.indexOf(' ');
  return spaceIdx === -1
    ? { key: line, value: '' }
    : { key: line.slice(0, spaceIdx), value: line.slice(spaceIdx + 1) };
}

export function parseOptionalHeaderBlock(
  lines: ReadonlyArray<string>,
  startIndex: number,
  onInvalidKey: (msg: string) => never,
  onDuplicateGpgsig: (msg: string) => never,
): {
  readonly gpgSignature: string | undefined;
  readonly extraHeaders: ReadonlyArray<{ readonly key: string; readonly value: string }>;
} {
  let gpgSignature: string | undefined;
  const extraHeaders: { readonly key: string; readonly value: string }[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const { key, value: firstValue } = parseHeaderLine(lines[i]!);
    if (key === '') {
      onInvalidKey('unexpected continuation line without preceding header');
    }

    const parts: string[] = [firstValue];
    let endIdx = i;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j]!;
      if (nextLine.startsWith(' ')) {
        parts.push(nextLine.slice(1));
        endIdx = j;
      } else {
        break;
      }
    }
    i = endIdx + 1;
    const value = parts.join('\n');

    if (key === 'gpgsig') {
      if (gpgSignature !== undefined) {
        onDuplicateGpgsig('duplicate gpgsig header');
      }
      gpgSignature = value;
    } else {
      extraHeaders.push({ key, value });
    }
  }

  return { gpgSignature, extraHeaders };
}

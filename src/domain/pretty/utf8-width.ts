import { DOUBLE_WIDTH_INTERVALS, ZERO_WIDTH_INTERVALS } from './utf8-width-tables.js';

const DEL = 0x7f;
const FIRST_PRINTABLE_LATIN1 = 0xa0;
const FIRST_PRINTABLE_ASCII = 0x20;
const NOT_A_CHARACTER_MASK = 0xfe;
const NOT_A_CHARACTER_PATTERN = 0xbe;
const MAX_FOUR_BYTE_LEAD = 0xf4;
const MAX_FOUR_BYTE_SECOND = 0x8f;
const DOUBLE_COLUMNS = 2;
const INVALID = -1;

interface Decoded {
  readonly codePoint: number;
  readonly length: number;
}

const isContinuation = (byte: number | undefined): byte is number =>
  byte !== undefined && (byte & 0xc0) === 0x80;

const inIntervals = (table: readonly number[], codePoint: number): boolean => {
  let low = 0;
  let high = table.length / 2 - 1;
  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    if (codePoint > (table[2 * mid + 1] as number)) {
      low = mid + 1;
    } else if (codePoint < (table[2 * mid] as number)) {
      high = mid - 1;
    } else {
      return true;
    }
  }
  return false;
};

const decodeTwo = (bytes: Uint8Array, at: number): Decoded | undefined => {
  const [lead, second] = [bytes[at] as number, bytes[at + 1]];
  if (!isContinuation(second) || (lead & 0xfe) === 0xc0) return undefined;
  return { codePoint: ((lead & 0x1f) << 6) | (second & 0x3f), length: 2 };
};

const decodeThree = (bytes: Uint8Array, at: number): Decoded | undefined => {
  const [lead, second, third] = [bytes[at] as number, bytes[at + 1], bytes[at + 2]];
  if (!isContinuation(second) || !isContinuation(third)) return undefined;
  const overlong = lead === 0xe0 && (second & 0xe0) === 0x80;
  const surrogate = lead === 0xed && (second & 0xe0) === 0xa0;
  const nonCharacter =
    lead === 0xef && second === 0xbf && (third & NOT_A_CHARACTER_MASK) === NOT_A_CHARACTER_PATTERN;
  if (overlong || surrogate || nonCharacter) return undefined;
  return {
    codePoint: ((lead & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
    length: 3,
  };
};

const decodeFour = (bytes: Uint8Array, at: number): Decoded | undefined => {
  const [lead, second, third, fourth] = [
    bytes[at] as number,
    bytes[at + 1],
    bytes[at + 2],
    bytes[at + 3],
  ];
  if (!isContinuation(second) || !isContinuation(third) || !isContinuation(fourth)) {
    return undefined;
  }
  const overlong = lead === 0xf0 && (second & 0xf0) === 0x80;
  const tooHigh = lead === MAX_FOUR_BYTE_LEAD && second > MAX_FOUR_BYTE_SECOND;
  if (overlong || tooHigh || lead > MAX_FOUR_BYTE_LEAD) return undefined;
  return {
    codePoint:
      ((lead & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f),
    length: 4,
  };
};

const decodeAt = (bytes: Uint8Array, at: number): Decoded | undefined => {
  const lead = bytes[at] as number;
  if (lead < 0x80) return { codePoint: lead, length: 1 };
  if ((lead & 0xe0) === 0xc0) return decodeTwo(bytes, at);
  if ((lead & 0xf0) === 0xe0) return decodeThree(bytes, at);
  if ((lead & 0xf8) === 0xf0) return decodeFour(bytes, at);
  return undefined;
};

const columnsOf = (codePoint: number): number => {
  if (codePoint === 0) return 0;
  if (codePoint < FIRST_PRINTABLE_ASCII) return INVALID;
  if (codePoint >= DEL && codePoint < FIRST_PRINTABLE_LATIN1) return INVALID;
  if (inIntervals(ZERO_WIDTH_INTERVALS, codePoint)) return 0;
  return inIntervals(DOUBLE_WIDTH_INTERVALS, codePoint) ? DOUBLE_COLUMNS : 1;
};

/**
 * Display columns of UTF-8 `bytes` as git counts them for a whole string:
 * control characters add nothing, and a string that is not valid UTF-8
 * counts one column per byte.
 */
export const utf8Width = (bytes: Uint8Array): number => {
  let width = 0;
  let at = 0;
  while (at < bytes.length) {
    const decoded = decodeAt(bytes, at);
    if (decoded === undefined) return bytes.length;
    width += Math.max(0, columnsOf(decoded.codePoint));
    at += decoded.length;
  }
  return width;
};

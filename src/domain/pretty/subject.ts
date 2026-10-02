import { concatBytes } from '../objects/encoding.js';
import { isAsciiSpace } from './ascii.js';

const LINE_FEED = 0x0a;
const SPACE = 0x20;
const DOT = 0x2e;
const DASH = 0x2d;
const UNDERSCORE = 0x5f;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;

const trimTrailingSpace = (line: Uint8Array): Uint8Array => {
  let end = line.length;
  while (end > 0 && isAsciiSpace(line[end - 1] as number)) end--;
  return line.subarray(0, end);
};

const splitLines = (raw: Uint8Array): ReadonlyArray<Uint8Array> => {
  const lines: Uint8Array[] = [];
  let start = 0;
  while (start < raw.length) {
    const found = raw.indexOf(LINE_FEED, start);
    const end = found === -1 ? raw.length : found;
    lines.push(raw.subarray(start, end));
    start = end + 1;
  }
  return lines;
};

/** git's `format_subject` with a space separator: lines joined, each stripped of trailing whitespace. */
export const formatSubject = (raw: Uint8Array): Uint8Array => {
  const parts = splitLines(raw).flatMap((line, index) => [
    ...(index === 0 ? [] : [Uint8Array.of(SPACE)]),
    trimTrailingSpace(line),
  ]);
  return concatBytes(parts);
};

const isAsciiAlnum = (byte: number): boolean =>
  (byte >= DIGIT_ZERO && byte <= DIGIT_NINE) ||
  (byte >= UPPER_A && byte <= UPPER_Z) ||
  (byte >= LOWER_A && byte <= LOWER_Z);

const isTitleChar = (byte: number): boolean =>
  isAsciiAlnum(byte) || byte === DOT || byte === UNDERSCORE;

const isTrimmedTail = (byte: number): boolean => byte === DOT || byte === DASH;

const sanitize = (subject: Uint8Array): number[] => {
  const out: number[] = [];
  let pendingSeparator = false;
  for (let index = 0; index < subject.length; index++) {
    const byte = subject[index] as number;
    if (!isTitleChar(byte)) {
      pendingSeparator = true;
      continue;
    }
    if (pendingSeparator && out.length > 0) out.push(DASH);
    pendingSeparator = false;
    out.push(byte);
    if (byte === DOT) while (subject[index + 1] === DOT) index++;
  }
  return out;
};

/** git's `format_sanitized_subject` (`%f`) over the joined subject. */
export const formatSanitizedSubject = (raw: Uint8Array): Uint8Array => {
  const out = sanitize(formatSubject(raw));
  while (out.length > 0 && isTrimmedTail(out[out.length - 1] as number)) out.pop();
  return Uint8Array.from(out);
};

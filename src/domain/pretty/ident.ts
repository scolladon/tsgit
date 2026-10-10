import { isAsciiDigit, isAsciiSpace } from './ascii.js';

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const PLUS = 0x2b;
const MINUS = 0x2d;

export interface IdentParts {
  readonly name?: Uint8Array;
  readonly mail?: Uint8Array;
  readonly date?: Uint8Array;
  readonly tz?: Uint8Array;
}

const skipWhile = (line: Uint8Array, from: number, accept: (byte: number) => boolean): number => {
  let cursor = from;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — past the end `line[cursor]` is `undefined`, which neither `isAsciiSpace` nor `isAsciiDigit` accepts (every comparison with it is false), so the walk stops at `line.length` either way.
  while (cursor < line.length && accept(line[cursor] as number)) cursor++;
  return cursor;
};

const skipSpaces = (line: Uint8Array, from: number): number => skipWhile(line, from, isAsciiSpace);

const nameEndBefore = (line: Uint8Array, mailBegin: number): number => {
  for (let cursor = mailBegin - 2; cursor >= 0; cursor--) {
    if (!isAsciiSpace(line[cursor] as number)) return cursor + 1;
  }
  return 0;
};

const isSign = (byte: number): boolean => byte === PLUS || byte === MINUS;

const splitDateAndTz = (line: Uint8Array, from: number): Pick<IdentParts, 'date' | 'tz'> => {
  const dateBegin = skipSpaces(line, from);
  const dateEnd = skipWhile(line, dateBegin, isAsciiDigit);
  const tzBegin = skipSpaces(line, dateEnd);
  if (dateEnd === dateBegin || !isSign(line[tzBegin] as number)) return {};
  const tzEnd = skipWhile(line, tzBegin + 1, isAsciiDigit);
  if (tzEnd === tzBegin + 1) return {};
  return { date: line.subarray(dateBegin, dateEnd), tz: line.subarray(tzBegin, tzEnd) };
};

/** git's `split_ident_line`: a malformed line yields no parts, a date-less one only name and mail. */
export const splitIdentLine = (line: Uint8Array): IdentParts => {
  const mailBegin = line.indexOf(LESS_THAN) + 1;
  if (mailBegin === 0) return {};
  const mailEnd = line.indexOf(GREATER_THAN, mailBegin);
  if (mailEnd === -1) return {};
  const name = line.subarray(0, nameEndBefore(line, mailBegin));
  const mail = line.subarray(mailBegin, mailEnd);
  return { name, mail, ...splitDateAndTz(line, line.lastIndexOf(GREATER_THAN) + 1) };
};

const TAB = 0x09;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

/** C `isspace` in the C locale: space, \t, \n, \v, \f, \r. */
export const isAsciiSpace = (byte: number): boolean =>
  byte === SPACE || (byte >= TAB && byte <= CARRIAGE_RETURN);

export const isAsciiDigit = (byte: number): boolean => byte >= DIGIT_ZERO && byte <= DIGIT_NINE;

/** C-locale lowercasing: folds `A`-`Z` only, never a non-ASCII letter. */
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

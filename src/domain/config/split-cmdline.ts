/** Why git's `split_cmdline` refuses a line, in git's words. */
export type SplitCmdlineError = 'cmdline ends with \\' | 'unclosed quote';

/** A line split into git's argv, or the reason it refuses. */
export type SplitCmdline =
  | { readonly kind: 'argv'; readonly argv: ReadonlyArray<string> }
  | { readonly kind: 'error'; readonly reason: SplitCmdlineError };

interface Cursor {
  readonly words: ReadonlyArray<string>;
  readonly word: string;
  /** The quote character the cursor is inside, or `''` outside any. */
  readonly quote: string;
  readonly at: number;
}

/** git's `isspace`: its ctype table marks only these, not `\v` or `\f`. */
const GIT_SPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);
const QUOTES: ReadonlySet<string> = new Set(["'", '"']);
const SINGLE_QUOTE = "'";
const BACKSLASH = '\\';
const UNQUOTED = '';

/**
 * git's `split_cmdline`: whitespace runs outside quotes separate words (so a
 * leading or trailing run yields an empty word), single quotes keep
 * everything literal, and a backslash outside them takes the next character
 * as is.
 */
export const splitCmdline = (cmdline: string): SplitCmdline => {
  let cursor: Cursor = { words: [], word: '', quote: UNQUOTED, at: 0 };
  while (cursor.at < cmdline.length) {
    const next = step(cmdline, cursor);
    if (next === undefined) return { kind: 'error', reason: 'cmdline ends with \\' };
    cursor = next;
  }
  if (cursor.quote !== UNQUOTED) return { kind: 'error', reason: 'unclosed quote' };
  return { kind: 'argv', argv: [...cursor.words, cursor.word] };
};

/** The cursor past the character it stands on; `undefined` on a backslash ending the line. */
const step = (line: string, cursor: Cursor): Cursor | undefined => {
  const c = line[cursor.at]!;
  const { quote, at } = cursor;
  if (quote === UNQUOTED && GIT_SPACE.has(c)) {
    return { ...cursor, words: [...cursor.words, cursor.word], word: '', at: pastSpaces(line, at) };
  }
  if (quote === UNQUOTED && QUOTES.has(c)) return { ...cursor, quote: c, at: at + 1 };
  if (c === quote) return { ...cursor, quote: UNQUOTED, at: at + 1 };
  if (c !== BACKSLASH || quote === SINGLE_QUOTE) return append(cursor, c, at + 1);
  const escaped = line[at + 1];
  return escaped === undefined ? undefined : append(cursor, escaped, at + 2);
};

const append = (cursor: Cursor, c: string, at: number): Cursor => ({
  ...cursor,
  word: cursor.word + c,
  at,
});

const pastSpaces = (line: string, at: number): number => {
  let next = at + 1;
  while (GIT_SPACE.has(line.charAt(next))) next++;
  return next;
};

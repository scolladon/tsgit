import { foldSubject } from '../objects/commit-message.js';

// Leading ASCII whitespace per git's `isspace` (space / tab / newline / vertical
// tab / form feed / carriage return) — Unicode-blind, mirroring git's parser.
const LEADING_ASCII_WHITESPACE = /^[ \t\n\v\f\r]+/;
const PATCH_PREFIX = '[PATCH';

/**
 * A commit's `git shortlog` oneline — a faithful port of git's
 * `insert_one_record` subject path. Folds the message to git's `%s`
 * ({@link foldSubject}), trims leading whitespace, drops a literal `[PATCH`
 * prefix through its first `]` (case-sensitive — `[BUGFIX]` / `[patch]` are
 * untouched), then trims leading whitespace again. The folded subject is a
 * single line, so the bracket search needs no end-of-line guard.
 */
export const cleanShortlogSubject = (message: string): string => {
  const folded = foldSubject(message).replace(LEADING_ASCII_WHITESPACE, '');
  const body = folded.startsWith(PATCH_PREFIX) ? dropToFirstBracket(folded) : folded;
  return body.replace(LEADING_ASCII_WHITESPACE, '');
};

const dropToFirstBracket = (subject: string): string => {
  const close = subject.indexOf(']');
  return close === -1 ? subject : subject.slice(close + 1);
};

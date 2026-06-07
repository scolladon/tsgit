/**
 * Commit-message normalization, a faithful port of git's `strbuf_stripspace`
 * with no comment prefix — i.e. the `whitespace` cleanup mode git applies when
 * a message is supplied via `-m`. Per `\n`-delimited line it strips trailing
 * ASCII whitespace; it then collapses consecutive blank lines to one, drops
 * leading and trailing blank lines, and guarantees exactly one trailing `\n`
 * (an empty result stays empty). Comment lines are preserved.
 *
 * git's `isspace` is ASCII-only, so non-ASCII whitespace (e.g. U+00A0) is kept
 * as content — this is why the porcelain must not lean on JS `String.trim()`,
 * which is Unicode-aware and would diverge from canonical git.
 */

// Trailing ASCII whitespace per git's `isspace`. `\n` is the line separator
// (split out before this runs), so only space / tab / vertical-tab / form-feed
// / carriage-return can appear trailing — the last covers CRLF endings.
const TRAILING_ASCII_WHITESPACE = /[ \t\v\f\r]+$/;

/**
 * A commit's subject: the first line of its message — everything before the
 * first `\n`, or the whole string when single-line. An empty message yields the
 * empty string. git splits on `\n` only, so a trailing CR (CRLF endings) is kept.
 */
export const subjectLine = (message: string): string => {
  const newline = message.indexOf('\n');
  return newline === -1 ? message : message.slice(0, newline);
};

/**
 * A commit's folded subject — git's `%s` (`format_subject`): the leading
 * paragraph collapsed to a single line, joining consecutive non-blank lines with
 * one space. Each line's trailing ASCII whitespace is stripped (git's
 * `is_blank_line`); leading blank lines are skipped, then the first blank line
 * after content ends the subject so the body never appears; leading whitespace on
 * a content line is preserved. Unlike `subjectLine`, a trailing CR (CRLF endings)
 * is trimmed rather than kept.
 */
export const foldSubject = (message: string): string => {
  const lines: string[] = [];
  for (const raw of message.split('\n')) {
    const line = raw.replace(TRAILING_ASCII_WHITESPACE, '');
    if (line === '') {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(line);
  }
  return lines.join(' ');
};

export const stripspace = (message: string): string => {
  const lines: string[] = [];
  for (const raw of message.split('\n')) {
    const line = raw.replace(TRAILING_ASCII_WHITESPACE, '');
    const previous = lines[lines.length - 1];
    // Drop leading blanks (nothing emitted yet) and collapse a run of blanks to
    // one; a blank only survives as a single separator between content lines.
    if (line === '' && (lines.length === 0 || previous === '')) continue;
    lines.push(line);
  }
  // Collapse guarantees at most one trailing blank; drop it, then re-terminate
  // with exactly one newline (an all-blank message yields the empty string).
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

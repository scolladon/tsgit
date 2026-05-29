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

export const stripspace = (message: string): string => {
  const lines: string[] = [];
  let blankPending = false;
  for (const line of message.split('\n')) {
    const cleaned = line.replace(TRAILING_ASCII_WHITESPACE, '');
    if (cleaned.length === 0) {
      blankPending = true;
      continue;
    }
    // A blank line only survives as a single separator between content lines;
    // leading blanks never flush because no content has been emitted yet.
    if (blankPending && lines.length > 0) lines.push('');
    blankPending = false;
    lines.push(cleaned);
  }
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
};

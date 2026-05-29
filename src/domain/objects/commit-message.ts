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

/**
 * Parsers for the two pointer-file grammars a linked worktree's admin dir
 * uses: the worktree's own `.git` gitfile (`gitdir: <path>`) and the admin
 * dir's `commondir` file. Pure — no I/O, no path resolution; resolving the
 * parsed path against the worktree's location is the caller's job.
 */

const GITDIR_PREFIX = 'gitdir: ';
const GITDIR_PREFIX_LENGTH = GITDIR_PREFIX.length;

export type GitfilePointer =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'invalid-format' }
  | { readonly kind: 'no-path' };

export type CommondirValue =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'empty' };

/** Strips a trailing run of `\r`/`\n` characters only — embedded newlines are kept verbatim. */
function stripTrailingCrlf(content: string): string {
  return content.replace(/[\r\n]+$/, '');
}

/**
 * Parses a worktree's `.git` gitfile content. Requires the exact `gitdir: `
 * prefix at index 0; the remainder (after stripping a trailing `\r`/`\n` run)
 * is the path verbatim, embedded newlines included.
 */
export const parseGitfilePointer = (content: string): GitfilePointer => {
  const stripped = stripTrailingCrlf(content);
  if (!stripped.startsWith(GITDIR_PREFIX)) {
    return { kind: 'invalid-format' };
  }

  const path = stripped.slice(GITDIR_PREFIX_LENGTH);
  return path.length === 0 ? { kind: 'no-path' } : { kind: 'ok', path };
};

/**
 * Parses an admin dir's `commondir` file content. No prefix; the whole
 * content (after stripping a trailing `\r`/`\n` run) is the path verbatim.
 * An absent file is not this parser's concern — the caller maps that to
 * `commonDir := gitDir`.
 */
export const parseCommondir = (content: string): CommondirValue => {
  const stripped = stripTrailingCrlf(content);
  return stripped.length === 0 ? { kind: 'empty' } : { kind: 'ok', path: stripped };
};

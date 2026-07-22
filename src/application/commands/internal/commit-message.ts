import { authorUnconfigured, emptyCommitMessage } from '../../../domain/commands/error.js';
import type { AuthorIdentity } from '../../../domain/objects/index.js';
import { stripspace } from '../../../domain/objects/index.js';

const MARKER_LABEL_MAX = 200;

interface ResolveAuthorInput {
  readonly explicit?: AuthorIdentity;
  readonly configUser?: AuthorIdentity;
}

interface ResolveCommitterInput {
  readonly explicit?: AuthorIdentity;
  readonly author?: AuthorIdentity;
  // Accepts an explicit `undefined` so callers need not pre-narrow an optional
  // identity; the `!== undefined` check below treats it as absent either way.
  readonly configUser?: AuthorIdentity | undefined;
}

/**
 * Resolution order: explicit param → repo config (`user.*`). When neither is
 * present, `AUTHOR_UNCONFIGURED` is thrown so the caller can prompt for setup.
 */
export const resolveAuthor = (input: ResolveAuthorInput): AuthorIdentity => {
  if (input.explicit !== undefined) return input.explicit;
  if (input.configUser !== undefined) return input.configUser;
  throw authorUnconfigured();
};

/**
 * Committer falls back to the resolved author, then to config — matching
 * `git commit`'s behavior where the committer can differ from the author
 * (e.g., when applying patches).
 */
export const resolveCommitter = (input: ResolveCommitterInput): AuthorIdentity => {
  if (input.explicit !== undefined) return input.explicit;
  if (input.author !== undefined) return input.author;
  if (input.configUser !== undefined) return input.configUser;
  throw authorUnconfigured();
};

/**
 * Normalize a commit message with git's `stripspace` (the `whitespace` cleanup
 * mode `git commit -m` applies): strip per-line trailing whitespace, collapse
 * blank-line runs, drop leading/trailing blanks, and guarantee a single
 * trailing newline. Throws `EMPTY_COMMIT_MESSAGE` when `allowEmpty` is false and
 * the cleaned result is empty (matches `git commit` default; the
 * `--allow-empty-message` flag flips the option).
 */
export const sanitizeMessage = (raw: string, opts: { readonly allowEmpty: boolean }): string => {
  const cleaned = stripspace(raw);
  if (cleaned === '' && !opts.allowEmpty) throw emptyCommitMessage();
  return cleaned;
};

/**
 * git's editor "commit cleanup" of `#`-comment lines: drop every line that
 * begins with `#` (e.g. a cherry-pick `# Conflicts:` block, or merge summary
 * comments). Applied to the MERGE_MSG / editor default, never to an explicit
 * `-m` message.
 */
export const stripComments = (message: string): string =>
  message
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');

/**
 * Sanitize a label for inclusion in conflict markers (`<<<<<<<` / `>>>>>>>`).
 * Strips bytes outside `0x20`–`0x7E` (escaped as `\xNN`), and truncates to
 * 200 bytes — keeps marker lines on a single line and within sane width.
 */
export const sanitizeMarkerLabel = (raw: string): string => {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      out += raw[i];
    } else {
      out += `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    }
    // Stryker disable next-line EqualityOperator: equivalent — `out` grows monotonically and the slice always caps at MARKER_LABEL_MAX, so `>` only defers the early return by one iteration while yielding the identical first-200-char result.
    if (out.length >= MARKER_LABEL_MAX) {
      return out.slice(0, MARKER_LABEL_MAX);
    }
  }
  return out;
};

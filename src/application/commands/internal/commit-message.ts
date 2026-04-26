import { authorUnconfigured, emptyCommitMessage } from '../../../domain/commands/error.js';
import type { AuthorIdentity } from '../../../domain/objects/index.js';

const MARKER_LABEL_MAX = 200;

interface ResolveAuthorInput {
  readonly explicit?: AuthorIdentity;
  readonly configUser?: AuthorIdentity;
}

interface ResolveCommitterInput {
  readonly explicit?: AuthorIdentity;
  readonly author?: AuthorIdentity;
  readonly configUser?: AuthorIdentity;
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
 * Trim a commit message. Throws `EMPTY_COMMIT_MESSAGE` when `allowEmpty` is
 * false and the trimmed result is empty (matches `git commit` default; the
 * `--allow-empty-message` flag flips the option).
 */
export const sanitizeMessage = (raw: string, opts: { readonly allowEmpty: boolean }): string => {
  const trimmed = raw.trim();
  if (trimmed === '' && !opts.allowEmpty) throw emptyCommitMessage();
  return trimmed;
};

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
    if (out.length >= MARKER_LABEL_MAX) {
      return out.slice(0, MARKER_LABEL_MAX);
    }
  }
  return out;
};

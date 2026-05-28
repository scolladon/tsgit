/**
 * Helpers private to the `remote` command. Shared by every action so the
 * validation rules and the canonical-refspec heuristic live in one place.
 */

import { remoteNameInvalid } from '../../../domain/commands/error.js';
import type { RefName } from '../../../domain/objects/object-id.js';
import type { ParsedConfig } from '../../primitives/config-read.js';

const FORBIDDEN_NAME_CHARS = /[\n\r\0"\\\]]/;

/**
 * Validate a remote subsection name. Rejects the empty string and the
 * line-surgery hard bans (`\n`, `\r`, `\0`, `"`, `\\`, `]`). Returns the
 * verbatim name on success — exporting the validator instead of inlining
 * each guard keeps every action's preconditions in a single source.
 */
export const validateRemoteName = (name: string): string => {
  if (name === '') {
    throw remoteNameInvalid(name, 'name must not be empty');
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    throw remoteNameInvalid(
      name,
      'name must not contain a newline, NUL, bracket, quote, or backslash',
    );
  }
  return name;
};

/**
 * Single referrer: a local branch whose `branch.<X>.remote` matches the
 * remote in question. `merge` carries the paired upstream branch (when
 * configured) so callers can clear both keys atomically.
 */
export interface BranchReferrer {
  readonly branch: string;
  readonly ref: RefName;
  readonly merge: string | undefined;
}

/**
 * Every local branch whose `branch.<name>.remote` equals `remoteName`.
 * Returned in iteration order so callers deduce a stable rewrite order.
 */
export const listBranchReferrers = (
  config: ParsedConfig,
  remoteName: string,
): ReadonlyArray<BranchReferrer> => {
  if (config.branch === undefined) return [];
  const referrers: BranchReferrer[] = [];
  for (const [branchName, entry] of config.branch) {
    if (entry.remote !== remoteName) continue;
    referrers.push({
      branch: branchName,
      ref: `refs/heads/${branchName}` as RefName,
      merge: entry.merge,
    });
  }
  return referrers;
};

/**
 * Apply the canonical-refspec rewrite from `from` to `to`. Only the exact
 * `+refs/heads/*:refs/remotes/<from>/*` form is matched; every other
 * refspec is preserved verbatim. Matches canonical git's
 * `builtin/remote.c::migrate_file` behaviour exactly.
 */
export const rewriteDefaultFetchRefspecs = (
  refspecs: ReadonlyArray<string>,
  from: string,
  to: string,
): ReadonlyArray<string> => {
  const canonical = `+refs/heads/*:refs/remotes/${from}/*`;
  const rewritten = `+refs/heads/*:refs/remotes/${to}/*`;
  return refspecs.map((spec) => (spec === canonical ? rewritten : spec));
};

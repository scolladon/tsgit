/**
 * Helpers private to the `remote` command. Shared by every action so the
 * validation rules and the canonical-refspec heuristic live in one place.
 */

import { remoteNameInvalid } from '../../../domain/commands/error.js';
import type { RefName } from '../../../domain/objects/object-id.js';
import { isSafeRefName } from '../../../domain/refs/ref-validation.js';
import type { ParsedConfig } from '../../primitives/config-read.js';

/** git's `valid_remote_name` probes the name as the remote component of a
 *  tracking ref: `refs/remotes/<name>/test` must be a valid ref name. */
const trackingRefProbe = (name: string): string => `refs/remotes/${name}/test`;

/**
 * git's `valid_remote_name`, and nothing more: the name must form a valid
 * `refs/remotes/<name>/` ref name — so an empty name, a control character,
 * a space, a backslash, `..`, a `.lock` component, … refuse, while `/`,
 * `"` and `]` are accepted as git accepts them. Returns the verbatim name.
 */
export const validateRemoteName = (name: string): string => {
  if (!isSafeRefName(trackingRefProbe(name))) {
    throw remoteNameInvalid(name, 'name does not form a valid refs/remotes/<name>/ ref name');
  }
  return name;
};

/** Why `name` would nest under or over the `existing` remote, if it does. */
const collisionReason = (existing: string, name: string): string | undefined => {
  if (name.startsWith(`${existing}/`)) return `subset of existing remote '${existing}'`;
  return existing.startsWith(`${name}/`) ? `superset of existing remote '${existing}'` : undefined;
};

/**
 * git's `check_remote_collision` for a new remote: a name nested under or
 * over a configured remote refuses — their tracking refs would share one
 * `refs/remotes/` namespace — reporting the first such remote in config order.
 */
export const assertRemoteNameUnnested = (config: ParsedConfig, name: string): void => {
  for (const existing of config.remote?.keys() ?? []) {
    const reason = collisionReason(existing, name);
    if (reason !== undefined) throw remoteNameInvalid(name, reason);
  }
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

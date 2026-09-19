/**
 * Helpers private to the `remote` command. Shared by every action so the
 * validation rules and the canonical-refspec heuristic live in one place.
 */

import { remoteNameInvalid } from '../../../domain/commands/error.js';
import type { RefName } from '../../../domain/objects/object-id.js';
import { refspecInvalid } from '../../../domain/protocol/error.js';
import { isSafeRefName } from '../../../domain/refs/ref-validation.js';
import type { Context } from '../../../ports/context.js';
import { type ParsedConfig, readConfig } from '../../primitives/config-read.js';
import { isValidFetchRefspec, isValidPushRefspec } from './refspec-grammar.js';

/** git's `valid_remote_name` probes the name as the remote component of a
 *  tracking ref: `refs/remotes/<name>/test` must be a valid ref name. */
const trackingRefProbe = (name: string): string => `refs/remotes/${name}/test`;

/**
 * git's `valid_remote_name` as a predicate: the name must form a valid
 * `refs/remotes/<name>/` ref name — so an empty name, a control character,
 * a space, a backslash, `..`, a `.lock` component, … are rejected, while
 * `/`, `"` and `]` pass, as git lets them. Composing `refs/remotes/<name>/…`
 * from a name that passes cannot escape the ref namespace.
 */
export const isValidRemoteName = (name: string): boolean => isSafeRefName(trackingRefProbe(name));

/** `isValidRemoteName`, raising `REMOTE_NAME_INVALID`. Returns the verbatim name. */
export const validateRemoteName = (name: string): string => {
  if (!isValidRemoteName(name)) {
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
  if (config.remote === undefined) return;
  for (const existing of config.remote.keys()) {
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
 * git builds its whole remote table out of the config before any remote
 * command runs its own logic, and `parse_refspec` dies right there — so ONE
 * unusable `remote.<any>.fetch` or `remote.<any>.push` value refuses the
 * command whatever remote it names, and ahead of every name refusal the
 * command would otherwise raise.
 */
export const assertRemoteRefspecsValid = (config: ParsedConfig): void => {
  for (const [, entry] of config.remote ?? []) {
    const invalid = firstInvalidRefspec(entry);
    if (invalid !== undefined) throw refspecInvalid(invalid, 'not a valid refspec');
  }
};

/** The first unusable refspec one remote configures — its fetch specs first,
 *  as git reads them, then its push specs. */
const firstInvalidRefspec = (entry: {
  readonly fetch?: ReadonlyArray<string>;
  readonly push?: ReadonlyArray<string>;
}): string | undefined =>
  (entry.fetch ?? []).find((spec) => !isValidFetchRefspec(spec)) ??
  (entry.push ?? []).find((spec) => !isValidPushRefspec(spec));

/** {@link readConfig} for a command that reaches a remote: the same read git
 *  builds its remote table from, and so the same point its refspec refusal
 *  lands at. */
export const readRemoteConfig = async (ctx: Context): Promise<ParsedConfig> => {
  const config = await readConfig(ctx);
  assertRemoteRefspecsValid(config);
  return config;
};

const TRACKING_DESTINATION_PREFIX = ':refs/remotes/';

/** git's marker for a refspec that fetches into a remote's own tracking
 *  namespace: the literal `:refs/remotes/<name>/`, anywhere in the spec. */
const trackingDestination = (name: string): string => `${TRACKING_DESTINATION_PREFIX}${name}/`;

/**
 * Whether any of `refspecs` fetches into `<name>`'s own tracking namespace.
 * git moves no tracking ref at all when none does — a remote with no fetch
 * refspec, a mirror's `+refs/*:refs/*` and a destination outside
 * `refs/remotes/<name>/` all leave every ref exactly where it was.
 */
export const mapsTrackingNamespace = (refspecs: ReadonlyArray<string>, name: string): boolean => {
  const marker = trackingDestination(name);
  return refspecs.some((spec) => spec.includes(marker));
};

/**
 * One refspec with the remote name spliced from `from` to `to` at the FIRST
 * `:refs/remotes/<from>/` it holds — whatever surrounds it, stars in odd
 * positions included. A refspec holding no such destination survives
 * verbatim, the shape git's `Not updating non-default fetch refspec` names.
 */
const rewriteFetchRefspec = (spec: string, from: string, to: string): string => {
  const at = spec.indexOf(trackingDestination(from));
  if (at < 0) return spec;
  const start = at + TRACKING_DESTINATION_PREFIX.length;
  return spec.slice(0, start) + to + spec.slice(start + from.length);
};

/** The destination half of a refspec, or `undefined` when it has none —
 *  a colon-free fetch refspec lands in `FETCH_HEAD`, never in a ref. */
const destinationOf = (spec: string): string | undefined => {
  const at = spec.indexOf(':');
  return at < 0 ? undefined : spec.slice(at + 1);
};

/** git's `match_name_with_pattern`: a destination holding one `*` matches
 *  any name framed by its two halves; one without matches only itself. */
const matchesDestination = (pattern: string, name: string): boolean => {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === name;
  const before = pattern.slice(0, star);
  const after = pattern.slice(star + 1);
  return (
    name.length >= before.length + after.length && name.startsWith(before) && name.endsWith(after)
  );
};

/**
 * Whether any of `refspecs` fetches INTO `name` — the per-ref destination
 * test git runs when it decides which refs a remote owns. A remote removes
 * only the refs it alone fetches into, so this answers both halves.
 */
export const fetchesInto = (refspecs: ReadonlyArray<string>, name: string): boolean =>
  refspecs.some((spec) => {
    const destination = destinationOf(spec);
    return destination !== undefined && matchesDestination(destination, name);
  });

/** Every refspec of a renamed remote, each spliced where it fetches into
 *  `from`'s own tracking namespace. */
export const rewriteTrackingFetchRefspecs = (
  refspecs: ReadonlyArray<string>,
  from: string,
  to: string,
): ReadonlyArray<string> => refspecs.map((spec) => rewriteFetchRefspec(spec, from, to));

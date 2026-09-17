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

const STAR = '*';

/** git's `is_glob_ref`: a refspec side is a pattern when it holds exactly
 *  one `*` — two of them are no more a pattern than none. */
const isGlobRef = (side: string): boolean => side.split(STAR).length === 2;

/**
 * git's `parse_refspec` for a FETCH refspec: a source carrying a `*` needs a
 * destination that is a pattern too, and a colon-free source has no
 * destination at all; a source without one refuses a pattern destination.
 * Every other shape passes — the colon-free plain name that lands in
 * `FETCH_HEAD` and an empty destination included.
 */
const isValidFetchRefspec = (spec: string): boolean => {
  const body = spec.startsWith('+') ? spec.slice(1) : spec;
  const colon = body.indexOf(':');
  const source = colon < 0 ? body : body.slice(0, colon);
  const destination = colon < 0 ? undefined : body.slice(colon + 1);
  if (source.length > 0 && source.includes(STAR)) {
    return destination !== undefined && isGlobRef(destination);
  }
  return destination === undefined || !isGlobRef(destination);
};

/**
 * git builds its whole remote table out of the config before any remote
 * command runs its own logic, and `parse_refspec` dies right there — so ONE
 * unusable `remote.<any>.fetch` value refuses the command whatever remote it
 * names, and ahead of every name refusal the command would otherwise raise.
 */
export const assertFetchRefspecsValid = (config: ParsedConfig): void => {
  for (const [, entry] of config.remote ?? []) {
    const invalid = (entry.fetch ?? []).find((spec) => !isValidFetchRefspec(spec));
    if (invalid !== undefined) throw refspecInvalid(invalid, 'wildcard sides do not agree');
  }
};

/** {@link readConfig} for a command that reaches a remote: the same read git
 *  builds its remote table from, and so the same point its refspec refusal
 *  lands at. */
export const readRemoteConfig = async (ctx: Context): Promise<ParsedConfig> => {
  const config = await readConfig(ctx);
  assertFetchRefspecsValid(config);
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

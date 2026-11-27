/**
 * git's remote-branch guess for `checkout <name>`: the remote-tracking ref a
 * bare name maps onto when no revision answers it. Stateless; reads config and
 * refs only, and only on the miss path its caller decides.
 */
import {
  checkoutPathOrTrackingBranch,
  checkoutRemoteBranchAmbiguous,
  configMissingValue,
} from '../../../domain/commands/error.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { hasGlobSpecial } from '../../../domain/pathspec/wildcard.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry, parseGitBoolean, readConfig } from '../../primitives/config-read.js';
import { findTrackingRef } from './remote-tracking-ref.js';
import { resolveRevisionExpression } from './revision-expression.js';
import { resolveRevisionName } from './revision-name.js';

/** A remote-tracking ref the guess settled on, and the object it named when read. */
export interface GuessedBranch {
  readonly ref: RefName;
  readonly id: ObjectId;
}

/** git's `unique_tracking_name` outcome: the chosen ref, and every remote that matched, in config order. */
export interface TrackingNameGuess {
  readonly chosen: GuessedBranch | undefined;
  readonly remotes: ReadonlyArray<string>;
}

interface RemoteMatch {
  readonly remote: string;
  readonly branch: GuessedBranch;
}

const CHECKOUT_SECTION = 'checkout';
const DEFAULT_REMOTE_KEY = 'defaultRemote';
const GUESS_KEY = 'guess';

/** git's `repo_config_get_string_tmp`: the last entry wins, and a valueless one dies. */
const readDefaultRemote = async (ctx: Context): Promise<string | undefined> => {
  const entry = await findLastEntry(ctx, CHECKOUT_SECTION, DEFAULT_REMOTE_KEY);
  if (entry === undefined) return undefined;
  if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
  return entry.value;
};

/** git's `repo_get_oid` on the mapped ref: the name through the ref ladder, else the revision grammar. */
const resolveMappedRef = async (ctx: Context, ref: RefName): Promise<ObjectId | undefined> =>
  (await resolveRevisionName(ctx, ref)) ?? resolveRevisionExpression(ctx, ref);

const remoteMatch = async (
  ctx: Context,
  remote: string,
  specs: ReadonlyArray<string>,
  name: string,
): Promise<RemoteMatch | undefined> => {
  const ref = findTrackingRef(specs, `${HEADS_PREFIX}${name}`);
  if (ref === undefined) return undefined;
  const id = await resolveMappedRef(ctx, ref);
  return id === undefined ? undefined : { remote, branch: { ref, id } };
};

/** git's `for_each_remote` + `check_tracking_name`: every remote whose mapped ref resolves, in config order. */
const remoteMatches = async (ctx: Context, name: string): Promise<ReadonlyArray<RemoteMatch>> => {
  const remotes = [...((await readConfig(ctx)).remote ?? [])];
  const matches = await Promise.all(
    remotes.map(([remote, entry]) => remoteMatch(ctx, remote, entry.fetch ?? [], name)),
  );
  return matches.filter((match): match is RemoteMatch => match !== undefined);
};

/** One match wins outright; among several, only the default remote's, compared case-sensitively. */
const chooseMatch = (
  matches: ReadonlyArray<RemoteMatch>,
  defaultRemote: string | undefined,
): GuessedBranch | undefined => {
  const [only, ...rest] = matches;
  if (only !== undefined && rest.length === 0) return only.branch;
  return matches.find((match) => match.remote === defaultRemote)?.branch;
};

/**
 * git's `unique_tracking_name`. The default remote is read before the walk, as git reads it,
 * so a valueless `checkout.defaultRemote` refuses whatever the walk would find.
 */
export const uniqueTrackingName = async (
  ctx: Context,
  name: string,
): Promise<TrackingNameGuess> => {
  const defaultRemote = await readDefaultRemote(ctx);
  const matches = await remoteMatches(ctx, name);
  return {
    chosen: chooseMatch(matches, defaultRemote),
    remotes: matches.map((match) => match.remote),
  };
};

/** A name the guess may answer, and whether git's `check_filename` found a path spelled so. */
export interface GuessCandidate {
  readonly name: string;
  readonly namesPath: boolean;
}

/**
 * git's `parse_remote_branch`, behind `parse_branchname_arg`'s `no_wildcard` gate: a name holding
 * a wildcard is never guessed, so nothing — not even the default remote — is read for it.
 * The file check needs a chosen ref, as git's does, so a file with several matching remotes
 * reports the ambiguity. The caller probes the path first, as git computes
 * `could_be_checkout_paths` before it decides whether to guess at all.
 */
export const parseRemoteBranch = async (
  ctx: Context,
  { name, namesPath }: GuessCandidate,
): Promise<GuessedBranch | undefined> => {
  if (hasGlobSpecial(name)) return undefined;
  const { chosen, remotes } = await uniqueTrackingName(ctx, name);
  if (chosen !== undefined && namesPath) throw checkoutPathOrTrackingBranch(name);
  if (chosen === undefined && remotes.length > 1) {
    throw checkoutRemoteBranchAmbiguous(name, remotes);
  }
  return chosen;
};

/**
 * `checkout.guess`, the last entry winning and a valueless one true. A value no boolean reads is
 * left on: the checkout gate has already refused it.
 */
export const readCheckoutGuess = async (ctx: Context): Promise<boolean> => {
  const entry = await findLastEntry(ctx, CHECKOUT_SECTION, GUESS_KEY);
  if (entry === undefined) return true;
  const parsed = parseGitBoolean(entry.value);
  return !parsed.ok || parsed.value;
};

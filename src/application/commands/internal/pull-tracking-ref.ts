/**
 * The remote-tracking ref a rebasing pull takes its fork point from: git pull's
 * `get_upstream_branch` for a configured upstream, `get_tracking_branch` for a
 * refspec given on the command line.
 */
import type { RefName } from '../../../domain/objects/index.js';
import { findTrackingRef } from './remote-tracking-ref.js';

const LOCAL_REMOTE = '.';

/** git's `branch_get_upstream`: a `.` remote tracks the local branch itself. */
export const upstreamTrackingRef = (
  remote: string,
  merge: string,
  // Stryker disable next-line ArrayDeclaration: equivalent — a lone positive spec without a destination maps nothing and no negative spec exists to exclude, so findTrackingRef answers undefined as for [].
  fetchSpecs: ReadonlyArray<string> = [],
): RefName | undefined =>
  remote === LOCAL_REMOTE ? (merge as RefName) : findTrackingRef(fetchSpecs, merge);

const REFSPEC_FORCE = '+';
const HEADS_PREFIXES = ['refs/heads/', 'heads/'] as const;
const UNTRACKED_PREFIXES = ['refs/', 'tags/', 'remotes/'] as const;

const HEAD = 'HEAD';

/** The branch a refspec source names — `HEAD` for none, nothing for a non-branch ref. */
const branchName = (source: string): string | undefined => {
  if (source === '') return HEAD;
  const prefix = HEADS_PREFIXES.find((candidate) => source.startsWith(candidate));
  if (prefix !== undefined) return source.slice(prefix.length);
  return UNTRACKED_PREFIXES.some((untracked) => source.startsWith(untracked)) ? undefined : source;
};

/** git's `get_tracking_branch`: the refspec's source under the default `refs/remotes/<remote>/` mapping. */
export const refspecTrackingRef = (remote: string, refspec: string): RefName | undefined => {
  const unforced = refspec.startsWith(REFSPEC_FORCE) ? refspec.slice(1) : refspec;
  const name = branchName(unforced.split(':')[0]!);
  if (name === undefined) return undefined;
  const base = remote === LOCAL_REMOTE ? 'refs/heads' : `refs/remotes/${remote}`;
  return `${base}/${name}` as RefName;
};

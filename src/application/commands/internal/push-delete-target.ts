/**
 * git's `match_explicit` for a delete refspec: the destination is matched
 * against the remote's refs as `count_refspec_match` does, and a destination
 * nothing matches is kept only when it is a full `refs/` name.
 */
import type { PushUnmatchedRefspec } from '../../../domain/commands/error.js';
import { refCandidates } from '../../../domain/refs/ref-candidates.js';
import { HEADS_PREFIX, TAGS_PREFIX } from '../../../domain/refs/ref-prefixes.js';

export type DeleteTargetMatch =
  | { readonly kind: 'matched'; readonly name: string }
  | { readonly kind: 'unmatched'; readonly reason: PushUnmatchedRefspec['reason'] };

const REFS_PREFIX = 'refs/';

/**
 * A match is strong when the destination names the ref in full, names it from
 * below `refs/`, or the ref is a branch or a tag; any other match is weak.
 */
const isStrongMatch = (dst: string, name: string): boolean =>
  name.length === dst.length ||
  dst.length === name.length - REFS_PREFIX.length ||
  name.startsWith(HEADS_PREFIX) ||
  name.startsWith(TAGS_PREFIX);

/** git's `count_refspec_match`: the strong matches when any, else the weak ones. */
const refspecMatches = (dst: string, names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const candidates = new Set<string>(refCandidates(dst));
  const matched = names.filter((name) => candidates.has(name));
  const strong = matched.filter((name) => isStrongMatch(dst, name));
  return strong.length > 0 ? strong : matched;
};

export const matchDeleteTarget = (
  dst: string,
  remoteNames: ReadonlyArray<string>,
): DeleteTargetMatch => {
  const matches = refspecMatches(dst, remoteNames);
  if (matches.length > 1) return { kind: 'unmatched', reason: 'ambiguous' };
  const [only] = matches;
  if (only !== undefined) return { kind: 'matched', name: only };
  if (dst.startsWith(REFS_PREFIX)) return { kind: 'matched', name: dst };
  return { kind: 'unmatched', reason: 'remote-ref-missing' };
};

/**
 * One path of an octopus step, resolved the way `git-merge-octopus` does:
 * `read-tree -m --aggressive` (`threeway_merge`) settles the trivial cases,
 * and `git-merge-one-file` takes what it leaves at stages 1-3.
 */
import type { FileMode, ObjectId } from '../objects/index.js';

export interface OctopusSide {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

type Entry = OctopusSide | undefined;

export type OctopusEntryResolution =
  | { readonly kind: 'take'; readonly side: OctopusSide }
  | { readonly kind: 'drop' }
  /** Both sides present and differing: `git merge-file` over the base (an empty one when absent). */
  | {
      readonly kind: 'content';
      readonly base: Entry;
      readonly head: OctopusSide;
      readonly remote: OctopusSide;
    }
  /** A case `git-merge-one-file` refuses: left at its stages, the working tree untouched. */
  | {
      readonly kind: 'unmerged';
      readonly base: Entry;
      readonly head: Entry;
      readonly remote: Entry;
    };

const DROP: OctopusEntryResolution = { kind: 'drop' };

/** `unpack-trees.c`'s `same`: both absent, or equal id and mode. */
const same = (a: Entry, b: Entry): boolean =>
  a === undefined || b === undefined ? a === b : a.id === b.id && a.mode === b.mode;

const take = (side: OctopusSide): OctopusEntryResolution => ({ kind: 'take', side });

interface Matches {
  readonly head: boolean;
  readonly remote: boolean;
}

/** `threeway_merge`'s `head_match` / `remote_match`: whether some base equals that side. */
const matchesOf = (bases: readonly Entry[], head: Entry, remote: Entry): Matches => ({
  head: bases.some((base) => same(base, head)),
  remote: bases.some((base) => same(base, remote)),
});

/** `threeway_merge` under `--aggressive`; `undefined` when it leaves the path unmerged. */
const trivialMerge = (
  head: Entry,
  remote: Entry,
  matches: Matches,
): OctopusEntryResolution | undefined => {
  if (remote !== undefined && matches.head && !matches.remote) return take(remote);
  if (head !== undefined && same(head, remote)) return take(head);
  if (head !== undefined && matches.remote && !matches.head) return take(head);
  if (head === undefined && (remote === undefined || matches.remote)) return DROP;
  if (remote === undefined && matches.head) return DROP;
  return undefined;
};

/**
 * `git-merge-one-file` over the stages `read-tree` left. Its add-only cases
 * never reach it — `--aggressive` already took a lone addition — so a missing
 * side here is a deletion against a base it refuses.
 */
const oneFileMerge = (base: Entry, head: Entry, remote: Entry): OctopusEntryResolution => {
  if (head !== undefined && remote !== undefined) return { kind: 'content', base, head, remote };
  return { kind: 'unmerged', base, head, remote };
};

export const resolveOctopusEntry = (
  bases: readonly Entry[],
  head: Entry,
  remote: Entry,
): OctopusEntryResolution => {
  const matches = matchesOf(bases, head, remote);
  const trivial = trivialMerge(head, remote, matches);
  if (trivial !== undefined) return trivial;
  // `threeway_merge` keeps the first present base at stage 1 unless both sides matched one.
  // Stryker disable next-line LogicalOperator: equivalent — past trivialMerge the two matches agree: a lone head match takes remote or drops, a lone remote match takes head or drops
  const base = matches.head && matches.remote ? undefined : bases.find((b) => b !== undefined);
  return oneFileMerge(base, head, remote);
};

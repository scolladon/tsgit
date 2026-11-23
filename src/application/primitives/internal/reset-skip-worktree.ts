import {
  type GitIndex,
  type IndexEntry,
  skipWorktreeEntry,
} from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
} from '../../../domain/git-index/index-path-key.js';
import type { SparseMatcher } from '../../../domain/sparse/index.js';

const stageZeroDonors = (currentIndex: GitIndex): Map<IndexPathKey, IndexEntry> => {
  const donors = new Map<IndexPathKey, IndexEntry>();
  for (const entry of currentIndex.entries) {
    if (entry.flags.stage === 0) donors.set(indexPathKey(entry), entry);
  }
  return donors;
};

const sameContent = (a: IndexEntry, b: IndexEntry): boolean => a.id === b.id && a.mode === b.mode;

const carriesReadBit = (
  entry: IndexEntry,
  donor: IndexEntry | undefined,
  sparse: SparseMatcher | undefined,
): boolean =>
  donor !== undefined
    ? donor.flags.skipWorktree
    : sparse !== undefined && !sparse(escapedPathOf(entry));

/**
 * The skip-worktree bit of each entry `reset --mixed` rebuilt, as git's
 * `update_index_from_diff` sets it: an unchanged entry is left untouched, a
 * changed one keeps the bit of the stage-0 entry it replaces, and a path with
 * no stage-0 entry follows the sparse patterns.
 */
export const applyResetSkipWorktree = (
  rebuilt: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  sparse: SparseMatcher | undefined,
): ReadonlyArray<IndexEntry> => {
  const donors = stageZeroDonors(currentIndex);
  return rebuilt.map((entry) => {
    const donor = donors.get(indexPathKey(entry));
    if (donor !== undefined && sameContent(donor, entry)) return entry;
    return carriesReadBit(entry, donor, sparse) ? skipWorktreeEntry(entry) : entry;
  });
};

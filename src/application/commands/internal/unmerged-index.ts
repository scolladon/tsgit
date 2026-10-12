import { mergeHasConflicts } from '../../../domain/commands/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import type { FilePath } from '../../../domain/objects/index.js';

/** Refuse an index that still holds a conflict, naming each unmerged path once. */
export const rejectUnmergedIndex = (entries: ReadonlyArray<IndexEntry>): void => {
  const unmerged = new Set<FilePath>();
  for (const entry of entries) {
    if (entry.flags.stage !== 0) unmerged.add(entry.path);
  }
  if (unmerged.size > 0) throw mergeHasConflicts(unmerged.size, [...unmerged]);
};

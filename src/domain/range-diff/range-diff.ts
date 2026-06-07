/**
 * Pure `range-diff` orchestrator over two already-hydrated patch series: render
 * each commit's `## ` text, pair them at minimum cost, and interleave the
 * correspondences into git's output order. The command supplies the I/O
 * (resolving revs, walking commits, reading trees/blobs); this stays pure.
 */

import { correspond } from './correspond.js';
import { interleave, type RangeDiffEntry } from './interleave.js';
import { type CommitPatchInput, renderRangePatch } from './patch-text.js';

export const rangeDiffEntries = (
  oldCommits: ReadonlyArray<CommitPatchInput>,
  newCommits: ReadonlyArray<CommitPatchInput>,
  creationFactor: number,
): ReadonlyArray<RangeDiffEntry> => {
  const oldRendered = oldCommits.map(renderRangePatch);
  const newRendered = newCommits.map(renderRangePatch);
  const { old, new: next } = correspond(oldRendered, newRendered, creationFactor);
  return interleave(old, next);
};

/**
 * Pure `range-diff` orchestrator over two already-rendered patch series: pair
 * them at minimum cost and interleave the correspondences into git's output
 * order. The command supplies the I/O (resolving revs, walking commits,
 * reading trees/blobs, rendering each `## ` text); this stays pure.
 */

import { correspond } from './correspond.js';
import { interleave, type RangeDiffEntry } from './interleave.js';
import type { RenderedPatch } from './patch-text.js';

export const rangeDiffEntries = (
  oldCommits: ReadonlyArray<RenderedPatch>,
  newCommits: ReadonlyArray<RenderedPatch>,
  creationFactor: number,
): ReadonlyArray<RangeDiffEntry> => {
  const { old, new: next } = correspond(oldCommits, newCommits, creationFactor);
  return interleave(old, next);
};

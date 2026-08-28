/**
 * Bench: `add` staging every unstaged working-tree file — the profiled `add`
 * write workload. Builds inside `sut` (add stages state, so it cannot loop in
 * place); the reported median therefore includes the per-iteration scratch
 * build. Accepted as advisory, non-gated coverage, faithful to the profiling
 * factory's own fresh-per-iteration model.
 */
import { afterAll } from 'vitest';

import { benchScenario } from './support/bench-dsl.js';
import { buildAddManyScratch, buildAddScratch, type ScratchRepo } from './support/write-scratch.js';

benchScenario(
  'Given a freshly built scratch repo with two unstaged files',
  'When add() stages them all, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];
    afterAll(async () => {
      await Promise.all(scratches.map((scratch) => scratch.dispose()));
    });

    const sut = async (): Promise<void> => {
      const scratch = await buildAddScratch();
      scratches.push(scratch);
      await scratch.repo.add([], { all: true });
    };
    return { sut };
  },
);

// 200 files gives the staging pool far more independent units than its I/O
// bound. Like every scenario in this file, the median INCLUDES the
// per-iteration fixture build (parallelised, but still ~200 file writes plus
// a repository open) — read deltas as advisory, never as an isolated
// staging-pool measurement.
const MANY_FILE_COUNT = 200;

benchScenario(
  'Given a freshly built scratch repo with 200 unstaged files across nested directories',
  'When add() stages them all, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];
    afterAll(async () => {
      await Promise.all(scratches.map((scratch) => scratch.dispose()));
    });

    const sut = async (): Promise<void> => {
      const scratch = await buildAddManyScratch(MANY_FILE_COUNT);
      scratches.push(scratch);
      await scratch.repo.add([], { all: true });
    };
    return { sut };
  },
);

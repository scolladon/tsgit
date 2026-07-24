/**
 * Bench: a non-fast-forward `merge` between two branches diverging by one
 * disjoint-file commit each — the profiled `merge` write workload. Builds
 * inside `sut` (a merge mutates state, so it cannot loop in place); the
 * reported median therefore includes the per-iteration scratch build.
 * Accepted as advisory, non-gated coverage, faithful to the profiling
 * factory's own fresh-per-iteration model.
 */
import { afterAll } from 'vitest';

import { benchScenario } from './support/bench-dsl.js';
import { buildMergeScratch, SCRATCH_AUTHOR, type ScratchRepo } from './support/write-scratch.js';

benchScenario(
  'Given two branches diverging by one disjoint-file commit each',
  'When merge.run() creates a non-fast-forward merge, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];
    afterAll(async () => {
      await Promise.all(scratches.map((scratch) => scratch.dispose()));
    });

    const sut = async (): Promise<void> => {
      const scratch = await buildMergeScratch(process.env);
      scratches.push(scratch);
      await scratch.repo.merge.run({
        rev: 'side',
        fastForward: 'never',
        author: SCRATCH_AUTHOR,
        committer: SCRATCH_AUTHOR,
      });
    };
    return { sut };
  },
);

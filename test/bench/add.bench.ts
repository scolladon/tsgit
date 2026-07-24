/**
 * Bench: `add` staging every unstaged working-tree file — the profiled `add`
 * write workload. Builds inside `sut` (add stages state, so it cannot loop in
 * place); the reported median therefore includes the per-iteration scratch
 * build. Accepted as advisory, non-gated coverage, faithful to the profiling
 * factory's own fresh-per-iteration model.
 */
import { afterAll } from 'vitest';

import { benchScenario } from './support/bench-dsl.js';
import { buildAddScratch, type ScratchRepo } from './support/write-scratch.js';

benchScenario(
  'Given a freshly built scratch repo with two unstaged files',
  'When add() stages them all, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];
    afterAll(async () => {
      await Promise.all(scratches.map((scratch) => scratch.dispose()));
    });

    const sut = async (): Promise<void> => {
      const scratch = await buildAddScratch(process.env);
      scratches.push(scratch);
      await scratch.repo.add([], { all: true });
    };
    return { sut };
  },
);

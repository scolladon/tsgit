/**
 * Bench: `commit` against a freshly staged scratch repo — the profiled
 * `commit` write workload. Builds inside `sut` (a commit mutates state, so it
 * cannot loop in place); the reported median therefore includes the
 * per-iteration scratch build. Accepted as advisory, non-gated coverage,
 * faithful to the profiling factory's own fresh-per-iteration model.
 */
import { afterAll } from 'vitest';

import { benchScenario } from './support/bench-dsl.js';
import { buildCommitScratch, SCRATCH_AUTHOR, type ScratchRepo } from './support/write-scratch.js';

benchScenario(
  'Given a freshly built scratch repo with one staged file',
  'When commit() records it, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];
    afterAll(async () => {
      await Promise.all(scratches.map((scratch) => scratch.dispose()));
    });

    const sut = async (): Promise<void> => {
      const scratch = await buildCommitScratch();
      scratches.push(scratch);
      await scratch.repo.commit({
        message: 'bench',
        author: SCRATCH_AUTHOR,
        committer: SCRATCH_AUTHOR,
      });
    };
    return { sut };
  },
);

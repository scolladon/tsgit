/**
 * Bench: `commit` against a freshly staged scratch repo — the profiled
 * `commit` write workload. Builds inside `sut` (a commit mutates state, so it
 * cannot loop in place); the reported median therefore includes the
 * per-iteration scratch build. Accepted as advisory, non-gated coverage,
 * faithful to the profiling factory's own fresh-per-iteration model.
 */
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { benchScenario } from './support/bench-dsl.js';
import {
  buildCommitScratch,
  buildWideCommitScratch,
  SCRATCH_AUTHOR,
  type ScratchRepo,
  wideFilePath,
} from './support/write-scratch.js';

benchScenario(
  'Given a freshly built scratch repo with one staged file',
  'When commit() records it, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];

    const sut = async (): Promise<void> => {
      const scratch = await buildCommitScratch();
      scratches.push(scratch);
      await scratch.repo.commit({
        message: 'bench',
        author: SCRATCH_AUTHOR,
        committer: SCRATCH_AUTHOR,
      });
    };
    return {
      teardown: (): void => {
        for (const scratch of scratches) scratch.disposeSync();
      },
      sut,
    };
  },
);

const WIDE_DIRECTORY_COUNT = 500;
const WIDE_FILES_PER_DIRECTORY = 4;

benchScenario(
  'Given a committed scratch repo of 500 directories with 4 files each',
  'When add() and commit() record one rewritten file per iteration, Then measure tsgit',
  async () => {
    const scratch = await buildWideCommitScratch(WIDE_DIRECTORY_COUNT, WIDE_FILES_PER_DIRECTORY);
    let counter = 0;
    return {
      teardown: (): void => scratch.disposeSync(),
      sut: async (): Promise<void> => {
        const target = wideFilePath(counter % WIDE_DIRECTORY_COUNT, 0);
        counter += 1;
        await writeFile(path.join(scratch.cwd, target), `rewrite ${counter}\n`);
        await scratch.repo.add([target]);
        await scratch.repo.commit({
          message: `bench ${counter}`,
          author: SCRATCH_AUTHOR,
          committer: SCRATCH_AUTHOR,
        });
      },
    };
  },
);

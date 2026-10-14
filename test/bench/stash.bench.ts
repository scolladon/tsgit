/**
 * Bench: one `stash push --include-untracked` + `stash pop` round trip. Each
 * iteration starts dirty (the pop restores the dirt) and ends dirty, so the
 * loop never drifts. Measures the index writes both commands now perform.
 */
import { benchScenario } from './support/bench-dsl.js';
import { buildStashScratch } from './support/write-scratch.js';

const MODIFIED_COUNT = 50;
const UNTRACKED_COUNT = 20;

benchScenario(
  'Given a scratch repo with 50 modified tracked files and 20 untracked files',
  'When stash push with untracked and stash pop round-trip, Then measure tsgit',
  async () => {
    const scratch = await buildStashScratch(MODIFIED_COUNT, UNTRACKED_COUNT);
    const sut = async (): Promise<void> => {
      await scratch.repo.stash.push({ includeUntracked: true });
      await scratch.repo.stash.pop();
    };
    return { sut, teardown: (): void => scratch.disposeSync() };
  },
);

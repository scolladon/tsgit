/**
 * Bench: `add` staging every unstaged working-tree file — the profiled `add`
 * write workload. Builds inside `sut` (add stages state, so it cannot loop in
 * place); the reported median therefore includes the per-iteration scratch
 * build. Accepted as advisory, non-gated coverage, faithful to the profiling
 * factory's own fresh-per-iteration model.
 */
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { Blob, ObjectId } from '../../src/domain/objects/index.js';
import { benchScenario } from './support/bench-dsl.js';
import {
  buildAddManyScratch,
  buildAddScratch,
  buildCommitScratch,
  buildManyLooseObjectsScratch,
  type ScratchRepo,
} from './support/write-scratch.js';

benchScenario(
  'Given a freshly built scratch repo with two unstaged files',
  'When add() stages them all, Then measure tsgit',
  () => {
    const scratches: ScratchRepo[] = [];

    const sut = async (): Promise<void> => {
      const scratch = await buildAddScratch();
      scratches.push(scratch);
      await scratch.repo.add([], { all: true });
    };
    return {
      teardown: (): void => {
        for (const scratch of scratches) scratch.disposeSync();
      },
      sut,
    };
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

    const sut = async (): Promise<void> => {
      const scratch = await buildAddManyScratch(MANY_FILE_COUNT);
      scratches.push(scratch);
      await scratch.repo.add([], { all: true });
    };
    return {
      teardown: (): void => {
        for (const scratch of scratches) scratch.disposeSync();
      },
      sut,
    };
  },
);

const blobOf = (text: string): Blob => ({
  type: 'blob',
  id: '' as ObjectId,
  content: new TextEncoder().encode(text),
});

benchScenario(
  'Given a scratch repo that never saw the object being written',
  'When writeObject() stores a brand-new blob, Then measure tsgit',
  async () => {
    const scratch = await buildCommitScratch();
    let counter = 0;
    return {
      teardown: (): void => scratch.disposeSync(),
      sut: async (): Promise<void> => {
        counter += 1;
        await scratch.repo.primitives.writeObject(blobOf(`brand new ${counter}\n`));
      },
    };
  },
);

benchScenario(
  'Given a scratch repo that already holds the object being written',
  'When writeObject() re-writes the present blob, Then measure tsgit',
  async () => {
    const scratch = await buildCommitScratch();
    const present = blobOf('already present\n');
    await scratch.repo.primitives.writeObject(present);
    return {
      teardown: (): void => scratch.disposeSync(),
      sut: async (): Promise<void> => {
        await scratch.repo.primitives.writeObject(present);
      },
    };
  },
);

benchScenario(
  'Given a scratch repo whose committed file is unchanged on disk',
  'When add() re-stages the unchanged file, Then measure tsgit',
  async () => {
    const scratch = await buildCommitScratch();
    return {
      teardown: (): void => scratch.disposeSync(),
      sut: async (): Promise<void> => {
        // Rewriting identical bytes bumps the mtime, so add() re-hashes a file whose blob is stored.
        await writeFile(path.join(scratch.cwd, 'a.txt'), 'a\n');
        await scratch.repo.add(['a.txt']);
      },
    };
  },
);

const LARGE_INDEX_FILE_COUNT = 10_000;

benchScenario(
  'Given a scratch repo with 10 000 committed files',
  'When add() re-stages one modified tracked file, Then measure tsgit',
  async () => {
    const scratch = await buildManyLooseObjectsScratch(LARGE_INDEX_FILE_COUNT);
    let counter = 0;
    return {
      teardown: (): void => scratch.disposeSync(),
      sut: async (): Promise<void> => {
        counter += 1;
        // A per-iteration payload forces a re-hash of the tracked file every time.
        await writeFile(path.join(scratch.cwd, 'f005000.txt'), `modified ${counter}\n`);
        await scratch.repo.add(['f005000.txt']);
      },
    };
  },
);

benchScenario(
  'Given a scratch repo with 10 000 committed files',
  'When add() stages one new file, Then measure tsgit',
  async () => {
    const scratch = await buildManyLooseObjectsScratch(LARGE_INDEX_FILE_COUNT);
    let counter = 0;
    return {
      teardown: (): void => scratch.disposeSync(),
      sut: async (): Promise<void> => {
        counter += 1;
        const name = `new-${counter}.txt`;
        await writeFile(path.join(scratch.cwd, name), `new ${counter}\n`);
        await scratch.repo.add([name]);
      },
    };
  },
);

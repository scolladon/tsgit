/**
 * Bench: reads through a `git clone --shared` borrower — informational. Its
 * objects live behind `objects/info/alternates`, so these rows price the
 * alternates lookup. They are kept out of the files the A/B shares with the
 * base ref: a tree that cannot follow alternates would fail them rather than
 * measure them.
 */
import * as path from 'node:path';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { setupSharedBorrower, setupSmallRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

const source = await setupSmallRepo({ commits: 50 });
const borrower = await setupSharedBorrower(source);
const blobId = borrower.firstBlobId as ObjectId;
const disposeFixtures = (): void => {
  removeSync(path.dirname(borrower.cwd));
  removeSync(source.cwd);
};

benchScenario(
  'Given a --shared borrower repository opened per call',
  'When readBlob() reads a blob owned by the lender, Then measure tsgit',
  () => ({
    sut: async (): Promise<void> => {
      const repo = await openRepository({ cwd: borrower.cwd });
      try {
        await repo.primitives.readBlob(blobId);
      } finally {
        await repo.dispose();
      }
    },
  }),
);

benchScenario(
  'Given a --shared borrower repository opened once',
  'When catFile() reads the HEAD commit, Then measure tsgit',
  async () => {
    const repo = await openRepository({ cwd: borrower.cwd });
    return {
      teardown: () => repo.dispose(),
      sut: async (): Promise<void> => {
        await repo.catFile({ ids: [borrower.headCommitId as ObjectId] });
      },
    };
  },
);

// Owns the shared fixtures' removal, so it must stay the last scenario.
benchScenario(
  'Given a --shared borrower repository opened once and every commit lent',
  'When log() walks every commit, Then measure tsgit',
  async () => {
    const repo = await openRepository({ cwd: borrower.cwd });
    return {
      teardown: async (): Promise<void> => {
        disposeFixtures();
        await repo.dispose();
      },
      sut: async (): Promise<void> => {
        await repo.log();
      },
    };
  },
);

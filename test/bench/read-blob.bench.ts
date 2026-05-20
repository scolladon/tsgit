/**
 * Bench scenario: `readBlob` cold (fresh ctx per call → no LRU cache hits) and
 * warm (same ctx, repeated call). Demonstrates the LRU-delta-base cache pay-off.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { setupSmallRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';

// One shared fixture for both scenarios. The warm scenario owns the
// dispose-time teardown via afterAll.
const fixture = await setupSmallRepo({ commits: 50 });
const blobId = fixture.firstBlobId as ObjectId;

benchScenario(
  'Given a fresh repository opened per call (cold LRU cache)',
  'When readBlob() reads a blob, Then compare tsgit against isomorphic-git',
  () => {
    const sut = async (): Promise<void> => {
      const repo = await openRepository({ cwd: fixture.cwd });
      try {
        await repo.primitives.readBlob(blobId);
      } finally {
        await repo.dispose();
      }
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

const warmRepo = await openRepository({ cwd: fixture.cwd });

benchScenario(
  'Given a repository with a warmed LRU delta-base cache',
  'When readBlob() reads a blob, Then compare tsgit against isomorphic-git',
  () => {
    afterAll(async () => {
      await warmRepo.dispose();
      await fixture.cleanup();
    });

    const sut = async (): Promise<void> => {
      await warmRepo.primitives.readBlob(blobId);
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

/**
 * Bench scenario: `readBlob` on a loose object — a fresh repository per call
 * (no LRU cache hits) against a small repo. `pack-read.bench.ts` exercises
 * the packed path; the tiered fixtures are read-only shared caches, so this
 * micro-scenario keeps its own throwaway loose repo and stays out of the
 * `pack-read` registry op (its basename is not a registry op).
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { setupSmallRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';

const fixture = await setupSmallRepo({ commits: 50 });
const blobId = fixture.firstBlobId as ObjectId;

benchScenario(
  'Given a fresh repository opened per call (cold LRU cache)',
  'When readBlob() reads a blob, Then compare tsgit against isomorphic-git',
  () => {
    afterAll(async () => {
      await fixture.cleanup();
    });

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

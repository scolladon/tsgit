/**
 * Scaled bench: `readBlob` against the deepest object in a deep-delta-chain
 * pack (evolving single-file fixture, chain depth ≈ 43).
 *
 * Cold reads a fresh repository per call, paying the full chain replay;
 * warm reuses one repository so the LRU delta-base cache hits. The deepest
 * object is the worst case for chain replay — a shallower object would not
 * exercise the memory-pressure path this scenario exists to measure.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { DELTA_CHAIN_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(DELTA_CHAIN_FIXTURE);

scaledScenario(
  ctx,
  'When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git',
  (fixture) => {
    const deepId = fixture.firstBlobId as ObjectId;
    const sut = async (): Promise<void> => {
      const repo = await openRepository({ cwd: fixture.cwd });
      try {
        await repo.primitives.readBlob(deepId);
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

scaledScenario(
  ctx,
  'When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    const deepId = fixture.firstBlobId as ObjectId;
    await repo.primitives.readBlob(deepId);
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.primitives.readBlob(deepId);
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

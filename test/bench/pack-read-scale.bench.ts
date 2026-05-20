/**
 * Scaled bench: `readBlob` against the medium fixture's pack (20k objects in
 * one pack — or the large 200k-object pack under `TSGIT_BENCH_LARGE`).
 *
 * Cold reads a fresh repository per call, paying full pack-index fanout +
 * inflate cost; warm reuses one repository so the LRU delta-base cache hits.
 * A single representative blob suffices — the cold path already exercises the
 * whole pack reader, so distinct ids would not change what is measured.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext();

scaledScenario(
  ctx,
  'When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git',
  (fixture) => {
    const blobId = fixture.firstBlobId as ObjectId;
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

scaledScenario(
  ctx,
  'When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    const blobId = fixture.firstBlobId as ObjectId;
    await repo.primitives.readBlob(blobId);
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.primitives.readBlob(blobId);
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

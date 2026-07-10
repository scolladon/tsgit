/**
 * Scaled bench: `readBlob` against the medium fixture's pack (20k objects in
 * one pack — or the large 200k-object pack under `TSGIT_BENCH_LARGE`).
 *
 * Cold reads a fresh repository per call, paying full pack-index fanout +
 * inflate cost; warm reuses one repository so the LRU delta-base cache hits.
 * A single representative blob suffices — the cold path already exercises the
 * whole pack reader, so distinct ids would not change what is measured.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const execFileAsync = promisify(execFile);

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

// Blob index -> on-disk path, matching fixture-generator.ts's (module-private)
// `blobPath` convention: `d${Math.floor(i / SHARD_SIZE)}/f${i}.dat`.
const SHARD_SIZE = 512;
const spreadBlobPath = (blobIndex: number): string =>
  `d${Math.floor(blobIndex / SHARD_SIZE)}/f${blobIndex}.dat`;

// Eight evenly-spaced indices across the large fixture's 200k blobs — spans
// many pack-index fanout buckets / pack regions in one measured call.
const SPREAD_INDICES = [0, 25_000, 50_000, 75_000, 100_000, 125_000, 150_000, 175_000];

const resolveSpreadIds = async (cwd: string): Promise<ReadonlyArray<ObjectId>> => {
  const ids: ObjectId[] = [];
  for (const index of SPREAD_INDICES) {
    const { stdout } = await execFileAsync('git', [
      '-C',
      cwd,
      'rev-parse',
      `HEAD:${spreadBlobPath(index)}`,
    ]);
    ids.push(stdout.trim() as ObjectId);
  }
  return ids;
};

// Net-new "large pack" signal: gated behind TSGIT_BENCH_LARGE so nightly CI
// (env unset) never registers it and the ~500 MB large fixture never
// generates there.
if (process.env.TSGIT_BENCH_LARGE !== undefined) {
  scaledScenario(
    ctx,
    'When readBlob() reads a spread of objects across a cold large pack, Then measure tsgit',
    async (fixture) => {
      const spread = await resolveSpreadIds(fixture.cwd);
      const sut = async (): Promise<void> => {
        const repo = await openRepository({ cwd: fixture.cwd });
        try {
          for (const id of spread) {
            await repo.primitives.readBlob(id);
          }
        } finally {
          await repo.dispose();
        }
      };
      return { sut };
    },
  );
}

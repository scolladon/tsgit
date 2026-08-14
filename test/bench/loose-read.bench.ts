/**
 * Bench scenarios: `readBlob` on a loose object against a small repo.
 * `pack-read.bench.ts` exercises the packed path; the tiered fixtures are
 * read-only shared caches, so these micro-scenarios keep their own
 * throwaway loose repo and stay out of the `pack-read` registry op (its
 * basename is not a registry op).
 *
 * Two scenarios, two different units of work:
 *  - the first, unchanged, opens a fresh repository *per call* (cold LRU
 *    cache) — it prices tsgit's handle lifecycle (open + dispose) together
 *    with the read, against isomorphic-git's stateless one-shot. That
 *    first-touch cost is real and is what this project actively works to
 *    reduce.
 *  - the second (companion) opens the repository *once* and reuses the
 *    handle across every measured call, matching the shape real long-lived
 *    consumers use, against the same isomorphic-git one-shot baseline.
 *    Neither call populates `ctx.deltaCache` (that only happens on the
 *    packed path), so both price a genuine loose read rather than an LRU
 *    hit.
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

afterAll(async () => {
  await fixture.cleanup();
});

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

benchScenario(
  'Given a repository handle opened once and reused across calls',
  'When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git',
  async () => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    return {
      sut: async (): Promise<void> => {
        await repo.primitives.readBlob(blobId);
      },
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

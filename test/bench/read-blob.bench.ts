/**
 * Bench scenario: `readBlob` cold (fresh ctx per call → no LRU cache hits) and
 * warm (same ctx, 1000th call). Demonstrates the LRU-delta-base cache pay-off.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll, bench, describe } from 'vitest';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { setupSmallRepo } from './fixtures.js';

// One shared fixture for both describes. Each block owns its own dispose-time
// teardown via afterAll so a failure in the cold scenario can't leak the
// tmpdir into the warm scenario or onto the OS.
const fixture = await setupSmallRepo({ commits: 50 });
const blobId = fixture.firstBlobId as ObjectId;

describe('readBlob:cold-cache', () => {
  bench('tsgit', async () => {
    const repo = await openRepository({ cwd: fixture.cwd });
    try {
      await repo.primitives.readBlob(blobId);
    } finally {
      await repo.dispose();
    }
  });

  bench('isomorphic-git', async () => {
    await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
  });
});

const warmRepo = await openRepository({ cwd: fixture.cwd });

describe('readBlob:warm-cache', () => {
  bench('tsgit', async () => {
    await warmRepo.primitives.readBlob(blobId);
  });

  bench('isomorphic-git', async () => {
    await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
  });

  afterAll(async () => {
    await warmRepo.dispose();
    await fixture.cleanup();
  });
});

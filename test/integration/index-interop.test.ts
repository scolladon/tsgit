/**
 * Cross-tool interop — `.git/index` equivalence under git ls-files
 * readback. Stat-cache fields (mtime/ctime/dev/ino) are intentionally
 * per-host, so byte-equality across two writers is impossible without
 * normalization. We assert the readable content (path, mode, sha, flags)
 * matches.
 *
 * @proves
 *   surface:        index
 *   bucket:         cross-tool-interop
 *   unique:         git ls-files --stage on tsgit-written index matches canonical
 *   interopSurface: index
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { GIT_AVAILABLE, initBothRepos, makePeerPair, type PeerPair } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('index interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('index');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given the same files staged by tsgit and canonical git', () => {
    describe('When git ls-files --stage reads each .git/index', () => {
      it('Then the stage listings agree on path, mode, and sha', async () => {
        // Arrange — write the same files to both work trees
        for (const dir of [pair.peer, pair.ours]) {
          await writeFile(path.join(dir, 'a.txt'), 'a\n');
          await writeFile(path.join(dir, 'b.txt'), 'b\n');
        }
        // Peer: canonical git stages them
        execFileSync('git', ['-C', pair.peer, 'add', 'a.txt', 'b.txt']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act — tsgit stages the same files
        await add(sut, ['a.txt', 'b.txt']);

        // Assert — git ls-files --stage from each side returns identical
        // (mode sha stage\tpath) triples.
        const peerListing = execFileSync('git', [
          '-C',
          pair.peer,
          'ls-files',
          '--stage',
        ]).toString();
        const oursListing = execFileSync('git', [
          '-C',
          pair.ours,
          'ls-files',
          '--stage',
        ]).toString();
        expect(oursListing).toBe(peerListing);
      });
    });
  });
});

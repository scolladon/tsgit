/**
 * Cross-tool interop — tree object. Builds a tree via tsgit's `writeTree`,
 * then asserts the SHA matches what canonical `git write-tree` produces
 * for the same staged content, and `git ls-tree` reads back the same
 * entries.
 *
 * @proves
 *   surface:        tree
 *   bucket:         cross-tool-interop
 *   unique:         tree object SHA + ls-tree readback match canonical git
 *   interopSurface: tree
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { writeTree } from '../../src/application/primitives/write-tree.js';
import { FILE_MODE, type ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, initBothRepos, makePeerPair, type PeerPair } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('tree interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('tree');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given two blobs and a tree composed of them', () => {
    describe('When tsgit writes the tree and canonical git stages the same files', () => {
      it('Then the resulting tree SHA matches and ls-tree round-trips', async () => {
        // Arrange — write two blobs to disk on the peer side and stage them
        await writeFile(path.join(pair.peer, 'a.txt'), 'A\n');
        await writeFile(path.join(pair.peer, 'b.txt'), 'B\n');
        execFileSync('git', ['-C', pair.peer, 'add', 'a.txt', 'b.txt']);
        const peerTreeSha = execFileSync('git', ['-C', pair.peer, 'write-tree']).toString().trim();
        const sut = createNodeContext({ workDir: pair.ours });

        // Act — write the two blobs to ours, then build the tree
        const blobA = await writeObject(sut, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('A\n'),
        });
        const blobB = await writeObject(sut, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('B\n'),
        });
        const oursTreeSha = await writeTree(sut, [
          { mode: FILE_MODE.REGULAR, name: 'a.txt', id: blobA },
          { mode: FILE_MODE.REGULAR, name: 'b.txt', id: blobB },
        ]);

        // Assert — SHA matches, and `git ls-tree` on our object returns the
        // same entries the peer's tree contains.
        expect(oursTreeSha).toBe(peerTreeSha);
        const ours = execFileSync('git', ['-C', pair.ours, 'ls-tree', oursTreeSha]).toString();
        const peer = execFileSync('git', ['-C', pair.peer, 'ls-tree', peerTreeSha]).toString();
        expect(ours).toBe(peer);
      });
    });
  });
});

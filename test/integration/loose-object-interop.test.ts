/**
 * Cross-tool interop — loose object equivalence-under-readback. tsgit's
 * `writeObject` lays a zlib-deflated payload under `.git/objects/<2>/<38>`.
 * Bytes are not pinned (zlib compression level is implementation-defined —
 * git uses 1, Node defaults to 6), but the SHA is over the decompressed
 * payload, so canonical git's `git cat-file -p` must read what we wrote.
 *
 * @proves
 *   surface:        looseObject
 *   bucket:         cross-tool-interop
 *   unique:         loose object readable by git cat-file with matching SHA + content
 *   interopSurface: looseObject
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, initBothRepos, makePeerPair, type PeerPair } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('loose-object interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('loose-object');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a blob payload', () => {
    describe('When tsgit writes the blob and canonical git hashes the same content', () => {
      it('Then the SHAs match and git cat-file reads the payload back', async () => {
        // Arrange
        const payload = 'hello, interop\n';
        const peerSha = execFileSync(
          'git',
          ['-C', pair.peer, 'hash-object', '-w', '--stdin', '-t', 'blob'],
          { input: payload },
        )
          .toString()
          .trim();
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        const oursSha = await writeObject(sut, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode(payload),
        });

        // Assert — SHAs match (decompressed payload is byte-identical) and
        // canonical git reads our blob and gets the same payload back.
        expect(oursSha).toBe(peerSha);
        const readBack = execFileSync('git', [
          '-C',
          pair.ours,
          'cat-file',
          '-p',
          oursSha,
        ]).toString();
        expect(readBack).toBe(payload);
      });
    });
  });
});

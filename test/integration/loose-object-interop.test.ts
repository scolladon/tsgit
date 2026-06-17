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
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';

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
        const peerSha = runGit(['-C', pair.peer, 'hash-object', '-w', '--stdin', '-t', 'blob'], {
          input: payload,
        }).trim();
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
        const readBack = runGit(['-C', pair.ours, 'cat-file', '-p', oursSha]);
        expect(readBack).toBe(payload);
      });
    });
  });

  describe('Given core.loosecompression=9 in the repo config', () => {
    describe('When tsgit writes a loose blob with NodeCompressor', () => {
      it('Then the loose file starts with zlib header 78 da (level-9) and git cat-file reads it back', async () => {
        // Arrange — write config with loosecompression=9 into the tsgit repo
        const configPath = path.join(pair.ours, '.git', 'config');
        await writeFile(
          configPath,
          '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tloosecompression = 9\n',
          'utf8',
        );
        const sut = createNodeContext({ workDir: pair.ours });
        __resetConfigCacheForTests();
        const payload = 'level-9 interop\n';

        // Act
        const sha = await writeObject(sut, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode(payload),
        });

        // Assert — loose file header is 78 da (zlib level-9)
        const looseDir = path.join(pair.ours, '.git', 'objects', sha.slice(0, 2));
        const looseFile = path.join(looseDir, sha.slice(2));
        const { readFile } = await import('node:fs/promises');
        const looseBytes = await readFile(looseFile);
        expect(looseBytes[0]).toBe(0x78);
        expect(looseBytes[1]).toBe(0xda);

        // Assert — git cat-file reads the blob back (equivalence-under-readback)
        const readBack = runGit(['-C', pair.ours, 'cat-file', '-p', sha]);
        expect(readBack).toBe(payload);
      });
    });
  });

  describe('Given no core.loosecompression in the repo config', () => {
    describe('When tsgit writes a loose blob with NodeCompressor', () => {
      it('Then the loose file uses the default zlib header 78 9c and git cat-file reads it back', async () => {
        // Arrange — no config override; NodeCompressor uses Node default (level 6)
        const sut = createNodeContext({ workDir: pair.ours });
        __resetConfigCacheForTests();
        const payload = 'default-level interop\n';

        // Act
        const sha = await writeObject(sut, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode(payload),
        });

        // Assert — default level header is 78 9c
        const looseFile = path.join(pair.ours, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
        const { readFile } = await import('node:fs/promises');
        const looseBytes = await readFile(looseFile);
        expect(looseBytes[0]).toBe(0x78);
        expect(looseBytes[1]).toBe(0x9c);

        // Assert — still readable by git
        const readBack = runGit(['-C', pair.ours, 'cat-file', '-p', sha]);
        expect(readBack).toBe(payload);
      });
    });
  });
});

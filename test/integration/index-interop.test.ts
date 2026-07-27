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
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';

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
        runGit(['-C', pair.peer, 'add', 'a.txt', 'b.txt']);
        const sut = createNodeContext({ workDir: pair.ours });

        // Act — tsgit stages the same files
        await add(sut, ['a.txt', 'b.txt']);

        // Assert — git ls-files --stage from each side returns identical
        // (mode sha stage\tpath) triples.
        const peerListing = runGit(['-C', pair.peer, 'ls-files', '--stage']);
        const oursListing = runGit(['-C', pair.ours, 'ls-files', '--stage']);
        expect(oursListing).toBe(peerListing);
      });
    });
  });

  describe('Given a file staged by tsgit, then re-staged untouched by canonical git', () => {
    describe('When both index entries are read back', () => {
      it('Then the nanosecond ctime/mtime fields agree (ns is populated, not hardcoded zero)', async () => {
        // Arrange — tsgit stages the file first.
        await writeFile(path.join(pair.ours, 'c.txt'), 'c\n');
        const sut = createNodeContext({ workDir: pair.ours });
        await add(sut, ['c.txt']);
        const tsgitEntry = (await readIndex(sut)).entries.find((e) => e.path === 'c.txt');

        // Act — canonical git re-stages the SAME untouched file (same inode,
        // same real ctime/mtime) into the same repo, overwriting the index.
        runGit(['-C', pair.ours, 'add', 'c.txt']);
        const gitEntry = (await readIndex(sut)).entries.find((e) => e.path === 'c.txt');

        // Assert — both writers derived ns from the identical underlying stat.
        expect(gitEntry?.mtimeNanoseconds).toBe(tsgitEntry?.mtimeNanoseconds);
        expect(gitEntry?.ctimeNanoseconds).toBe(tsgitEntry?.ctimeNanoseconds);
      });
    });
  });
});

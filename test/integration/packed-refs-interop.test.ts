/**
 * Cross-tool interop — `.git/packed-refs` byte equality. Drives canonical
 * `git pack-refs --all` to produce a known-good packed-refs file, parses
 * it with tsgit, re-serializes via tsgit, and asserts the round-tripped
 * bytes match the original.
 *
 * @proves
 *   surface:        packedRefs
 *   bucket:         cross-tool-interop
 *   unique:         packed-refs round-trips through tsgit parser+serializer
 *   interopSurface: packedRefs
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePackedRefs, serializePackedRefs } from '../../src/domain/refs/packed-refs.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('packed-refs interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('packed-refs');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a repo with branches and an annotated tag packed by canonical git', () => {
    describe('When the packed-refs file is parsed by tsgit and re-serialized', () => {
      it('Then the round-tripped bytes match canonical git output', async () => {
        // Arrange — peer with one commit, one feature branch, and an annotated
        // tag. `pack-refs --all` writes .git/packed-refs.
        const env = {
          ...runGitEnv(),
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_AUTHOR_DATE: '1700000000 +0000',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
          GIT_COMMITTER_DATE: '1700000000 +0000',
        };
        runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });
        runGit(['-C', pair.peer, 'branch', 'feature']);
        runGit(['-C', pair.peer, 'tag', '-a', 'v1', '-m', 'release'], { env });
        runGit(['-C', pair.peer, 'pack-refs', '--all']);
        const original = await readFile(path.join(pair.peer, '.git/packed-refs'), 'utf8');

        // Act — parse and re-serialize through tsgit
        const sut = parsePackedRefs(original);
        const roundTripped = serializePackedRefs(sut);

        // Assert
        expect(roundTripped).toBe(original);
      });
    });
  });
});

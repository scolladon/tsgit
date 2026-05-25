/**
 * Cross-tool interop — annotated tag object. Writes a Tag via tsgit's
 * `writeObject`, compares its SHA against `git tag -a` output, and asserts
 * `git cat-file -p` reads back the same content.
 *
 * @proves
 *   surface:        tag
 *   bucket:         cross-tool-interop
 *   unique:         tag object SHA + cat-file readback match canonical git
 *   interopSurface: tag
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, initBothRepos, makePeerPair, type PeerPair } from './interop-helpers.js';

const TAGGER: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe.skipIf(!GIT_AVAILABLE)('tag interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('tag');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given an annotated tag on an empty commit', () => {
    describe('When tsgit writes the tag and canonical git tag -a does the same', () => {
      it('Then SHAs match and cat-file readback agrees', async () => {
        // Arrange — make a commit in peer with pinned dates, tag it
        const env = {
          ...process.env,
          GIT_AUTHOR_NAME: TAGGER.name,
          GIT_AUTHOR_EMAIL: TAGGER.email,
          GIT_AUTHOR_DATE: `${TAGGER.timestamp} ${TAGGER.timezoneOffset}`,
          GIT_COMMITTER_NAME: TAGGER.name,
          GIT_COMMITTER_EMAIL: TAGGER.email,
          GIT_COMMITTER_DATE: `${TAGGER.timestamp} ${TAGGER.timezoneOffset}`,
        };
        execFileSync('git', ['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env,
        });
        const commitSha = execFileSync('git', ['-C', pair.peer, 'rev-parse', 'HEAD'])
          .toString()
          .trim() as ObjectId;
        execFileSync('git', ['-C', pair.peer, 'tag', '-a', 'v1', '-m', 'release one', commitSha], {
          env,
        });
        const peerTagSha = execFileSync('git', ['-C', pair.peer, 'rev-parse', 'v1'])
          .toString()
          .trim();
        const sut = createNodeContext({ workDir: pair.ours });
        // Replicate the same commit in ours via canonical git so cat-file -p
        // resolves the referenced object.
        execFileSync('git', ['-C', pair.ours, 'commit', '-q', '--allow-empty', '-m', 'seed'], {
          env,
        });

        // Act
        const oursTagSha = await writeObject(sut, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commitSha,
            objectType: 'commit',
            tagName: 'v1',
            tagger: TAGGER,
            message: 'release one\n',
            extraHeaders: [],
          },
        });

        // Assert
        expect(oursTagSha).toBe(peerTagSha);
        const peerOut = execFileSync('git', [
          '-C',
          pair.peer,
          'cat-file',
          '-p',
          peerTagSha,
        ]).toString();
        const oursOut = execFileSync('git', [
          '-C',
          pair.ours,
          'cat-file',
          '-p',
          oursTagSha,
        ]).toString();
        expect(oursOut).toBe(peerOut);
      });
    });
  });
});

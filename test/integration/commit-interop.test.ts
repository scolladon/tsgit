/**
 * Cross-tool interop — commit object. Builds a commit via tsgit's
 * `createCommit`; canonical git produces the same commit via
 * `git commit-tree` with pinned author/committer dates. Asserts SHA
 * equality and `git cat-file -p` readback.
 *
 * @proves
 *   surface:        commit
 *   bucket:         cross-tool-interop
 *   unique:         commit object SHA + cat-file readback match canonical git
 *   interopSurface: commit
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { createCommit } from '../../src/application/primitives/create-commit.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { writeTree } from '../../src/application/primitives/write-tree.js';
import { type AuthorIdentity, FILE_MODE, type ObjectId } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, initBothRepos, makePeerPair, type PeerPair } from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe.skipIf(!GIT_AVAILABLE)('commit interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('commit');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a tree and a pinned author/committer identity', () => {
    describe('When tsgit createCommit and canonical git commit-tree run', () => {
      it('Then the commit SHAs match', async () => {
        // Arrange — produce the tree on both sides
        await writeFile(path.join(pair.peer, 'a.txt'), 'hello\n');
        execFileSync('git', ['-C', pair.peer, 'add', 'a.txt']);
        const peerTreeSha = execFileSync('git', ['-C', pair.peer, 'write-tree']).toString().trim();
        const peerCommitSha = execFileSync(
          'git',
          ['-C', pair.peer, 'commit-tree', peerTreeSha, '-m', 'first'],
          {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: AUTHOR.name,
              GIT_AUTHOR_EMAIL: AUTHOR.email,
              GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
              GIT_COMMITTER_NAME: AUTHOR.name,
              GIT_COMMITTER_EMAIL: AUTHOR.email,
              GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
            },
          },
        )
          .toString()
          .trim();
        const sut = createNodeContext({ workDir: pair.ours });
        const blob = await writeObject(sut, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('hello\n'),
        });
        const tree = await writeTree(sut, [{ mode: FILE_MODE.REGULAR, name: 'a.txt', id: blob }]);

        // Act
        const oursCommitSha = await createCommit(sut, {
          tree,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'first\n',
        });

        // Assert
        expect(oursCommitSha).toBe(peerCommitSha);
        const oursOut = execFileSync('git', [
          '-C',
          pair.ours,
          'cat-file',
          '-p',
          oursCommitSha,
        ]).toString();
        const peerOut = execFileSync('git', [
          '-C',
          pair.peer,
          'cat-file',
          '-p',
          peerCommitSha,
        ]).toString();
        expect(oursOut).toBe(peerOut);
      });
    });
  });
});

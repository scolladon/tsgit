/**
 * Cross-tool interop — merge-engine commands over trees holding a non-UTF-8
 * path. The histories are built with plumbing, tsgit acts through
 * `openRepository`, and the assertions read path bytes from `git ls-files -s -z`.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         merge-engine commands carry raw path bytes like git
 *   interopSurface: merge
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  hashBlob,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitBytes,
  runGitEnv,
  stageRaw,
} from './interop-helpers.js';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const REGULAR_MODE = '100644';
const FF_TXT = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const FF_TXT_LATIN1 = 'ÿ.txt';
const VIEW_PATH = '�.txt';

describe.skipIf(!GIT_AVAILABLE)(
  'merge path bytes interop — stash apply',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    const stage = (
      rows: ReadonlyArray<{ readonly path: Uint8Array; readonly oid: string }>,
    ): void =>
      stageRaw(
        pair.peer,
        rows.map((row) => ({ mode: REGULAR_MODE, ...row })),
      );

    const commitIndex = (message: string): string =>
      git('commit-tree', git('write-tree').trim(), '-m', message).trim();

    const stagedRecords = (): string[] =>
      Buffer.from(runGitBytes(['-C', pair.peer, 'ls-files', '-s', '-z']))
        .toString('latin1')
        .split('\0')
        .filter((record) => record !== '');

    beforeEach(async () => {
      pair = await makePeerPair('merge-path-bytes');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
    });

    afterEach(async () => {
      await repo?.dispose();
      repo = undefined;
      await pair.dispose();
    });

    describe('Given the non-UTF-8 path staged as l2 over a committed l1', () => {
      describe('When stash push then stash apply restoring the index run', () => {
        it('Then the modify/delete conflict names the view and stages 1 and 2 keep the raw bytes', async () => {
          // Arrange
          const [l1, l2] = [hashBlob(pair.peer, 'l1\n'), hashBlob(pair.peer, 'l2\n')];
          stage([{ path: FF_TXT, oid: l1 }]);
          git('update-ref', 'refs/heads/main', commitIndex('seed'));
          stage([{ path: FF_TXT, oid: l2 }]);
          repo = await openRepository({ cwd: pair.peer });
          await repo.stash.push();
          // git cannot reset the absent file on macOS, so its index still holds l2 at apply time
          stage([{ path: FF_TXT, oid: l2 }]);

          // Act
          const sut = repo.stash;
          const result = await sut.apply({ restoreIndex: true });

          // Assert
          expect(result).toEqual({
            kind: 'conflict',
            conflicts: [{ path: VIEW_PATH, type: 'modify-delete' }],
          });
          expect(stagedRecords()).toEqual([
            `${REGULAR_MODE} ${l1} 1\t${FF_TXT_LATIN1}`,
            `${REGULAR_MODE} ${l2} 2\t${FF_TXT_LATIN1}`,
          ]);
        });
      });
    });
  },
);

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
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  hashBlob,
  makePeerPair,
  mergeTreeResult,
  type PeerPair,
  runGit,
  runGitBytes,
  runGitEnv,
  stageRaw,
  tryRunGit,
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

const A_PATH = Uint8Array.of(0x61);
const C_PATH = Uint8Array.of(0x63);

interface History {
  readonly path: Uint8Array;
  readonly sideBlob: string;
}

describe.skipIf(!GIT_AVAILABLE)(
  'merge path bytes interop — cherry-pick and revert',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    const gitIn = (dir: string, ...args: ReadonlyArray<string>): string =>
      runGit(['-C', dir, ...args], { env: COMMIT_ENV });

    const stageIn = (dir: string, rows: ReadonlyArray<{ path: Uint8Array; oid: string }>): void =>
      stageRaw(
        dir,
        rows.map((row) => ({ mode: REGULAR_MODE, ...row })),
      );

    const commitIn = (dir: string, ref: string, message: string, parent?: string): string => {
      const parents = parent === undefined ? [] : ['-p', parent];
      const id = gitIn(
        dir,
        'commit-tree',
        gitIn(dir, 'write-tree').trim(),
        ...parents,
        '-m',
        message,
      );
      gitIn(dir, 'update-ref', ref, id.trim());
      return id.trim();
    };

    const records = (dir: string): string =>
      Buffer.from(runGitBytes(['-C', dir, 'ls-files', '-s', '-z'])).toString('latin1');

    const headTree = (dir: string): string => gitIn(dir, 'rev-parse', 'HEAD^{tree}').trim();

    /** base: a, `path`; side edits `path`; main edits `a`; worktree holds only the UTF-8 file `a`. */
    const seedHistory = (dir: string, history: History): void => {
      runGit(['init', '-q', '-b', 'main', dir]);
      runGit(['-C', dir, 'config', 'user.name', 'Ada']);
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
      const [a0, a1, base] = [
        hashBlob(dir, 'a0\n'),
        hashBlob(dir, 'a1\n'),
        hashBlob(dir, 'base\n'),
      ];
      stageIn(dir, [
        { path: A_PATH, oid: a0 },
        { path: history.path, oid: base },
      ]);
      const root = commitIn(dir, 'refs/heads/main', 'base');
      stageIn(dir, [{ path: history.path, oid: hashBlob(dir, history.sideBlob) }]);
      commitIn(dir, 'refs/heads/side', 'side', root);
      gitIn(dir, 'read-tree', root);
      stageIn(dir, [{ path: A_PATH, oid: a1 }]);
      commitIn(dir, 'refs/heads/main', 'main', root);
      gitIn(dir, 'read-tree', 'main');
      gitIn(dir, 'checkout-index', '-f', '--', 'a');
    };

    beforeEach(async () => {
      pair = await makePeerPair('merge-path-bytes-pick');
    });

    afterEach(async () => {
      await repo?.dispose();
      repo = undefined;
      await pair.dispose();
    });

    const expectSameOutcome = async (
      gitArgs: ReadonlyArray<string>,
      tsgit: (sut: Repository) => Promise<unknown>,
    ): Promise<void> => {
      const gitRun = tryRunGit(['-C', pair.peer, ...gitArgs], { env: COMMIT_ENV });
      repo = await openRepository({ cwd: pair.ours });
      const tsgitRun = await tsgit(repo).then(
        () => true,
        () => false,
      );
      expect(tsgitRun).toBe(gitRun.ok);
      expect(headTree(pair.ours)).toBe(headTree(pair.peer));
      expect(records(pair.ours)).toBe(records(pair.peer));
    };

    describe('Given a lossy path that the picked commit modifies and the work tree lacks', () => {
      describe('When cherry-picking it', () => {
        it('Then the commit carries the merge-tree result and the path stays an unstaged deletion', async () => {
          // Arrange
          seedHistory(pair.ours, { path: FF_TXT, sideBlob: 'side\n' });
          const engineTree = mergeTreeResult(pair.ours, 'main', 'side').tree;
          repo = await openRepository({ cwd: pair.ours });

          // Act
          const sut = repo.cherryPick;
          await sut.run({ commits: ['side'] });

          // Assert
          expect(headTree(pair.ours)).toBe(engineTree);
          expect(records(pair.ours)).toContain(
            `${REGULAR_MODE} ${hashBlob(pair.ours, 'side\n')} 0\t${FF_TXT_LATIN1}`,
          );
          expect(gitIn(pair.ours, 'status', '--porcelain', '-z')).toBe(` D ${VIEW_PATH}\0`);
          expect(() => gitIn(pair.ours, 'fsck', '--strict')).not.toThrow();
        });
      });
    });

    describe('Given a lossy path that the reverted commit leaves untouched', () => {
      describe('When reverting the tip', () => {
        it('Then tsgit ends in the state git ends in', async () => {
          // Arrange
          const history = { path: FF_TXT, sideBlob: 'side\n' };
          seedHistory(pair.peer, history);
          seedHistory(pair.ours, history);

          // Act + Assert
          await expectSameOutcome(['revert', '--no-edit', 'HEAD'], (sut) =>
            sut.revert.run({ commits: ['HEAD'] }),
          );
        });
      });
    });

    describe('Given a UTF-8 tracked file deleted on disk and left unstaged', () => {
      describe('When cherry-picking an unrelated commit', () => {
        it('Then tsgit picks it like git and leaves the deletion unstaged', async () => {
          // Arrange
          const history = { path: C_PATH, sideBlob: 'side\n' };
          for (const dir of [pair.peer, pair.ours]) {
            seedHistory(dir, history);
            gitIn(dir, 'checkout-index', '-f', '--', 'c');
            rmSync(path.join(dir, 'a'));
          }

          // Act + Assert
          await expectSameOutcome(['cherry-pick', 'side'], (sut) =>
            sut.cherryPick.run({ commits: ['side'] }),
          );
          expect(gitIn(pair.ours, 'status', '--porcelain')).toBe(
            gitIn(pair.peer, 'status', '--porcelain'),
          );
        });
      });
    });
  },
);

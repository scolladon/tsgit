/**
 * Cross-tool interop — git's `remove_branch_state`. A stopped merge, pick or
 * revert is built by canonical git, copied, then ended once by git and once by
 * tsgit; the in-progress state files each leaves behind must agree.
 *
 * @proves
 *   surface:        branch-state
 *   bucket:         cross-tool-interop
 *   unique:         ending a stopped operation removes the same branch-state files as git
 *   interopSurface: branch-state
 */
import { existsSync } from 'node:fs';
import { cp, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const IDENTITY = { name: 'Ada', email: 'ada@example.com', date: '1700000000 +0000' };

const ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_AUTHOR_DATE: IDENTITY.date,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  GIT_COMMITTER_DATE: IDENTITY.date,
};

const STATE_FILES = [
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'SQUASH_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'AUTO_MERGE',
  'sequencer',
] as const;

const gitIn = (dir: string, ...args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: ENV });

const stateFilesOf = (dir: string): ReadonlyArray<string> =>
  STATE_FILES.filter((name) => existsSync(path.join(dir, '.git', name)));

describe.skipIf(!GIT_AVAILABLE)('branch-state removal interop', () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('branch-state');
    repo = undefined;
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const write = (file: string, content: string): Promise<void> =>
    writeFile(path.join(pair.peer, file), content);

  const commitAll = async (file: string, content: string, message: string): Promise<void> => {
    await write(file, content);
    gitIn(pair.peer, 'add', file);
    runGit(['-C', pair.peer, 'commit', '-q', '-m', message], { env: ENV });
  };

  /** main and side both rewrite `f`; side then adds `h` twice. */
  const seedDivergedHistory = async (): Promise<void> => {
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    gitIn(pair.peer, 'config', 'commit.gpgsign', 'false');
    await commitAll('f', 'base\n', 'base');
    gitIn(pair.peer, 'checkout', '-q', '-b', 'side');
    await commitAll('f', 'side\n', 'side');
    await commitAll('h', 's2\n', 'side2');
    await commitAll('h', 's3\n', 'side3');
    gitIn(pair.peer, 'checkout', '-q', 'main');
    await commitAll('f', 'main\n', 'main');
  };

  const openOurCopy = async (): Promise<Repository> => {
    await cp(pair.peer, pair.ours, { recursive: true });
    repo = await openRepository({ cwd: pair.ours });
    return repo;
  };

  const resolveF = async (): Promise<void> => {
    await write('f', 'resolved\n');
    gitIn(pair.peer, 'add', 'f');
  };

  const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (err) {
      return (err as { data?: unknown }).data;
    }
    return undefined;
  };

  describe('Given a merge stopped on a conflict', () => {
    describe('When both tools reset --hard', () => {
      it('Then both leave no branch state', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', 'side');
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '--hard');
        await sut({ mode: 'hard', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual([]);
      });
    });

    describe('When both tools reset --soft', () => {
      it('Then both refuse in the middle of a merge and keep the state', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', 'side');
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        const git = gitIn(pair.peer, 'reset', '--soft');
        const result = await codeOf(() => sut({ mode: 'soft', rev: 'HEAD' }));

        // Assert
        expect(git.stderr).toBe('fatal: Cannot do a soft reset in the middle of a merge.\n');
        expect(result).toEqual({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
        expect(stateFilesOf(pair.ours)).toEqual(stateFilesOf(pair.peer));
      });
    });
  });

  describe('Given a multi-pick stopped on its first pick, resolved', () => {
    describe('When both tools reset --soft', () => {
      it('Then both drop the pick state and keep the sequencer', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'cherry-pick', 'side~2', 'side~1');
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '--soft');
        await sut({ mode: 'soft', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual(['sequencer']);
      });
    });
  });

  describe('Given a multi-pick stopped on its last pick, resolved', () => {
    describe('When both tools reset --mixed', () => {
      it('Then both drop the pick state and the sequencer', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'cherry-pick', 'side~1', 'side~2');
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset');
        await sut({ mode: 'mixed', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a squash merge awaiting its commit', () => {
    describe('When both tools reset --hard', () => {
      it('Then both drop SQUASH_MSG', async () => {
        // Arrange
        await seedDivergedHistory();
        gitIn(pair.peer, 'merge', '--squash', 'side');
        await resolveF();
        const ours = await openOurCopy();
        const sut = ours.reset;

        // Act
        gitIn(pair.peer, 'reset', '--hard');
        await sut({ mode: 'hard', rev: 'HEAD' });

        // Assert
        const result = stateFilesOf(pair.ours);
        expect(result).toEqual(stateFilesOf(pair.peer));
        expect(result).toEqual([]);
      });
    });
  });
});

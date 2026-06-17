/**
 * Cross-tool interop — `rm` porcelain. Removes the same tracked path via
 * `repo.rm` (through the `openRepository` facade) and via canonical `git rm`
 * on a peer repo, then asserts the resulting index (`git ls-files --stage`)
 * and working tree agree — including the `--cached` variant (index-only) and
 * the untracked-path refusal (git and tsgit both refuse, mutating nothing).
 *
 * The seed file is committed (not just staged) so the comparison targets `rm`
 * on a HEAD-tracked path — `git rm` refuses a staged-but-uncommitted file
 * without `-f`, an orthogonal safety valve, not the removal semantics here.
 *
 * @proves
 *   surface:        rm
 *   bucket:         cross-tool-interop
 *   unique:         rm porcelain index+worktree state matches canonical git rm
 *   interopSurface: rm
 */
import { stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

describe.skipIf(!GIT_AVAILABLE)('rm porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('rm');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const seedCommitted = async (name: string, content: string): Promise<void> => {
    await writeFile(path.join(pair.peer, name), content);
    await writeFile(path.join(pair.ours, name), content);
    runGit(['-C', pair.peer, 'add', name]);
    runGit(['-C', pair.peer, 'commit', '-q', '-m', 'seed'], {
      env: COMMIT_ENV,
    });
    await repo.add([name]);
    await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });
  };

  const pathExists = async (dir: string, rel: string): Promise<boolean> => {
    try {
      await stat(path.join(dir, rel));
      return true;
    } catch {
      return false;
    }
  };

  describe('Given a committed tracked file in both repos', () => {
    describe('When repo.rm removes it like git rm', () => {
      it('Then the index entry and working file are gone identically to git', async () => {
        // Arrange
        await seedCommitted('a.txt', 'hello\n');

        // Act
        const removed = await repo.rm(['a.txt']);
        runGit(['-C', pair.peer, 'rm', '-q', 'a.txt']);
        const sut = lsStage(pair.ours);

        // Assert
        expect(sut).toBe(lsStage(pair.peer));
        expect(removed.removed).toEqual(['a.txt']);
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(false);
      });
    });
  });

  describe('Given a committed tracked file in both repos', () => {
    describe('When repo.rm --cached removes it like git rm --cached', () => {
      it('Then the index entry is gone but the working file stays, like git', async () => {
        // Arrange
        await seedCommitted('a.txt', 'hello\n');

        // Act
        await repo.rm(['a.txt'], { cached: true });
        runGit(['-C', pair.peer, 'rm', '-q', '--cached', 'a.txt']);
        const sut = lsStage(pair.ours);

        // Assert
        expect(sut).toBe(lsStage(pair.peer));
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(true);
      });
    });
  });

  describe('Given an untracked path', () => {
    describe('When repo.rm is asked to remove it', () => {
      it('Then it refuses like git rm and mutates nothing', async () => {
        // Arrange
        await seedCommitted('a.txt', 'hello\n');
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'rm', 'ghost.txt']);
        let code = '';
        try {
          await repo.rm(['ghost.txt']);
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('PATHSPEC_NO_MATCH');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  const writeBoth = async (name: string, content: string): Promise<void> => {
    await writeFile(path.join(pair.peer, name), content);
    await writeFile(path.join(pair.ours, name), content);
  };
  const stageBoth = async (name: string): Promise<void> => {
    runGit(['-C', pair.peer, 'add', name]);
    await repo.add([name]);
  };
  const repoRmCode = async (
    paths: ReadonlyArray<string>,
    opts?: { cached?: boolean; force?: boolean },
  ): Promise<string> => {
    try {
      await repo.rm(paths, opts);
      return '';
    } catch (error) {
      return (error as TsgitError).data.code;
    }
  };

  describe('Given a path with staged changes in both repos', () => {
    describe('When repo.rm and git rm try to remove it', () => {
      it('Then both refuse and the index + working tree are unchanged and identical', async () => {
        // Arrange
        await seedCommitted('a.txt', 'one\n');
        await writeBoth('a.txt', 'two\n');
        await stageBoth('a.txt');
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'rm', 'a.txt']);
        const code = await repoRmCode(['a.txt']);

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('RM_STAGED_CHANGES');
        expect(lsStage(pair.ours)).toBe(before);
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(true);
      });
    });

    describe('When both pass --cached', () => {
      it('Then both drop the index entry and keep the working file, identically', async () => {
        // Arrange
        await seedCommitted('a.txt', 'one\n');
        await writeBoth('a.txt', 'two\n');
        await stageBoth('a.txt');

        // Act — --cached suppresses the staged-only valve in git and tsgit alike.
        await repo.rm(['a.txt'], { cached: true });
        runGit(['-C', pair.peer, 'rm', '--cached', 'a.txt']);

        // Assert
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(true);
      });
    });
  });

  describe('Given a path with local modifications in both repos', () => {
    describe('When repo.rm and git rm try to remove it', () => {
      it('Then both refuse and the index + working tree are unchanged and identical', async () => {
        // Arrange
        await seedCommitted('a.txt', 'one\n');
        await writeBoth('a.txt', 'local\n');
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'rm', 'a.txt']);
        const code = await repoRmCode(['a.txt']);

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('RM_LOCAL_MODIFICATIONS');
        expect(lsStage(pair.ours)).toBe(before);
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(true);
      });
    });
  });

  describe('Given a path with both staged and local changes in both repos', () => {
    describe('When repo.rm and git rm try to remove it (plain, then --cached)', () => {
      it('Then both refuse plain and refuse --cached (only -f would force)', async () => {
        // Arrange
        await seedCommitted('a.txt', 'one\n');
        await writeBoth('a.txt', 'two\n');
        await stageBoth('a.txt');
        await writeBoth('a.txt', 'three\n');
        const before = lsStage(pair.ours);

        // Act / Assert — plain refuses
        expect(tryRunGit(['-C', pair.peer, 'rm', 'a.txt']).ok).toBe(false);
        expect(await repoRmCode(['a.txt'])).toBe('RM_STAGED_AND_LOCAL_CHANGES');
        // --cached still refuses (unlike the staged-only / local-only cases)
        expect(tryRunGit(['-C', pair.peer, 'rm', '--cached', 'a.txt']).ok).toBe(false);
        expect(await repoRmCode(['a.txt'], { cached: true })).toBe('RM_STAGED_AND_LOCAL_CHANGES');
        expect(lsStage(pair.ours)).toBe(before);
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      });
    });

    describe('When both pass -f / force', () => {
      it('Then both remove the index entry and working file, identically', async () => {
        // Arrange
        await seedCommitted('a.txt', 'one\n');
        await writeBoth('a.txt', 'two\n');
        await stageBoth('a.txt');
        await writeBoth('a.txt', 'three\n');

        // Act
        await repo.rm(['a.txt'], { force: true });
        runGit(['-C', pair.peer, 'rm', '-f', 'a.txt']);

        // Assert
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(false);
      });
    });
  });
});

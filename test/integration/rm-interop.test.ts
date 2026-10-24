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
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  indexExtensionOf,
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
        const result = lsStage(pair.ours);

        // Assert
        expect(result).toBe(lsStage(pair.peer));
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
        const result = lsStage(pair.ours);

        // Assert
        expect(result).toBe(lsStage(pair.peer));
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

  describe('Given a committed directory d in both repos', () => {
    const seedDirectory = async (): Promise<void> => {
      await mkdir(path.join(pair.peer, 'd'));
      await mkdir(path.join(pair.ours, 'd'));
      await seedCommitted('d/a', 'a\n');
    };

    describe('When repo.rm and git rm name d without -r', () => {
      it('Then both refuse with the same message and remove nothing', async () => {
        // Arrange
        await seedDirectory();
        const before = lsStage(pair.ours);
        let message = '';

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'rm', 'd']);
        try {
          await repo.rm(['d']);
        } catch (error) {
          message = (error as TsgitError).message;
        }

        // Assert
        expect(peerRun.stderr).toBe("fatal: not removing 'd' recursively without -r\n");
        expect(message).toContain("not removing 'd' recursively without -r");
        expect(lsStage(pair.ours)).toBe(before);
        expect(lsStage(pair.peer)).toBe(before);
      });
    });

    describe('When repo.rm recursive and git rm -r name d', () => {
      it('Then both drop the directory from the index and the working tree', async () => {
        // Arrange
        await seedDirectory();

        // Act
        await repo.rm(['d'], { recursive: true });
        runGit(['-C', pair.peer, 'rm', '-r', '-q', 'd']);
        const result = lsStage(pair.ours);

        // Assert
        expect(result).toBe(lsStage(pair.peer));
        await expect(pathExists(pair.ours, 'd/a')).resolves.toBe(false);
      });
    });
  });

  describe('Given a tracked sibling already deleted from the working tree', () => {
    describe('When repo.rm and git rm remove the last file on disk of the directory', () => {
      it('Then both remove the emptied directory', async () => {
        // Arrange
        await mkdir(path.join(pair.peer, 'd'));
        await mkdir(path.join(pair.ours, 'd'));
        await seedCommitted('d/a', 'a\n');
        await seedCommitted('d/b', 'b\n');
        await rm(path.join(pair.peer, 'd/b'));
        await rm(path.join(pair.ours, 'd/b'));

        // Act
        await repo.rm(['d/a']);
        runGit(['-C', pair.peer, 'rm', '-q', 'd/a']);

        // Assert
        await expect(pathExists(pair.peer, 'd')).resolves.toBe(false);
        await expect(pathExists(pair.ours, 'd')).resolves.toBe(false);
      });
    });
  });

  describe('Given a stopped operation leaving a/f unmerged in both repos', () => {
    type Operation = 'merge' | 'cherry-pick' | 'revert';

    const put = async (dir: string, file: string, content: string): Promise<void> => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    };

    const commitAll = (dir: string, message: string): void => {
      runGit(['-C', dir, 'add', '-A'], { env: COMMIT_ENV });
      runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
    };

    const stop = (dir: string, operation: Operation): void => {
      const args = operation === 'revert' ? ['revert', '--no-edit', 'HEAD~1'] : [operation, 'side'];
      expect(tryRunGit(['-C', dir, ...args], { env: COMMIT_ENV }).ok).toBe(false);
    };

    const buildStopped = async (dir: string, operation: Operation): Promise<void> => {
      runGit(['init', '-q', '-b', 'main', dir]);
      await put(dir, 'a/f', 'base\n');
      await put(dir, 'h', 'h\n');
      commitAll(dir, 'base');
      runGit(['-C', dir, 'checkout', '-q', '-b', 'side']);
      await put(dir, 'a/f', 'side\n');
      commitAll(dir, 'side');
      runGit(['-C', dir, 'checkout', '-q', 'main']);
      await put(dir, 'a/f', 'main\n');
      commitAll(dir, 'main');
      if (operation === 'revert') {
        await put(dir, 'a/f', 'main2\n');
        commitAll(dir, 'main2');
      }
      stop(dir, operation);
    };

    const reucOf = async (dir: string): Promise<string> =>
      Buffer.from((await indexExtensionOf(dir, 'REUC')) ?? []).toString('hex');

    const expectSameState = async (): Promise<void> => {
      expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      expect(await reucOf(pair.ours)).toBe(await reucOf(pair.peer));
      expect(runGit(['-C', pair.ours, 'ls-files', '--resolve-undo'])).toBe(
        runGit(['-C', pair.peer, 'ls-files', '--resolve-undo']),
      );
      expect(tryRunGit(['-C', pair.ours, 'fsck']).ok).toBe(true);
    };

    describe.each([
      { operation: 'merge', cached: false },
      { operation: 'merge', cached: true },
      { operation: 'cherry-pick', cached: false },
      { operation: 'revert', cached: false },
    ] as const)(
      'When repo.rm and git rm remove a/f ($operation, cached $cached)',
      ({ operation, cached }) => {
        it('Then the index, REUC and resolve-undo listing match canonical git', async () => {
          // Arrange
          await rm(pair.ours, { recursive: true, force: true });
          await rm(pair.peer, { recursive: true, force: true });
          await buildStopped(pair.peer, operation);
          await buildStopped(pair.ours, operation);
          await repo.dispose();
          repo = await openRepository({ cwd: pair.ours });

          // Act
          await repo.rm(['a/f'], cached ? { cached: true } : {});
          runGit(['-C', pair.peer, 'rm', '-q', ...(cached ? ['--cached'] : []), 'a/f']);

          // Assert
          await expectSameState();
        });
      },
    );

    describe('When the worktree file of a/f was modified further', () => {
      it('Then both remove it without refusing and match', async () => {
        // Arrange
        await rm(pair.ours, { recursive: true, force: true });
        await rm(pair.peer, { recursive: true, force: true });
        await buildStopped(pair.peer, 'merge');
        await buildStopped(pair.ours, 'merge');
        for (const dir of [pair.peer, pair.ours]) {
          const file = path.join(dir, 'a/f');
          await writeFile(file, `${await readFile(file, 'utf8')}more\n`);
        }
        await repo.dispose();
        repo = await openRepository({ cwd: pair.ours });

        // Act
        await repo.rm(['a/f']);
        runGit(['-C', pair.peer, 'rm', '-q', 'a/f']);

        // Assert
        await expectSameState();
      });
    });
  });

  const seedCommittedIn = async (name: string): Promise<void> => {
    await mkdir(path.dirname(path.join(pair.peer, name)), { recursive: true });
    await mkdir(path.dirname(path.join(pair.ours, name)), { recursive: true });
    await writeBoth(name, 'one\n');
    runGit(['-C', pair.peer, 'add', name]);
    runGit(['-C', pair.peer, 'commit', '-q', '-m', 'seed'], { env: COMMIT_ENV });
    await repo.add([name]);
    await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });
  };
  const porcelainOf = (dir: string): string => runGit(['-C', dir, 'status', '--porcelain']);

  describe('Given a tracked file the user already deleted from disk', () => {
    describe('When repo.rm and git rm remove it', () => {
      it('Then both succeed and stage the deletion identically', async () => {
        // Arrange
        await seedCommitted('f', 'one\n');
        await rm(path.join(pair.ours, 'f'));
        await rm(path.join(pair.peer, 'f'));

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'rm', 'f']);
        const result = await repo.rm(['f']);

        // Assert
        expect(peerRun.ok).toBe(true);
        expect(result.removed).toEqual(['f']);
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        expect(porcelainOf(pair.ours)).toBe('D  f\n');
        expect(porcelainOf(pair.ours)).toBe(porcelainOf(pair.peer));
      });
    });
  });

  describe('Given a tracked file whose containing directory is gone from disk', () => {
    describe('When repo.rm and git rm remove it', () => {
      it('Then both succeed and stage the deletion identically', async () => {
        // Arrange
        await seedCommittedIn('dd/f');
        await rm(path.join(pair.ours, 'dd'), { recursive: true });
        await rm(path.join(pair.peer, 'dd'), { recursive: true });

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'rm', 'dd/f']);
        const result = await repo.rm(['dd/f']);

        // Assert
        expect(peerRun.ok).toBe(true);
        expect(result.removed).toEqual(['dd/f']);
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        expect(porcelainOf(pair.ours)).toBe('D  dd/f\n');
        expect(porcelainOf(pair.ours)).toBe(porcelainOf(pair.peer));
      });
    });
  });
});

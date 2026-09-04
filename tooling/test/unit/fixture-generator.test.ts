import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEEP_ANCESTRY_SMALL,
  ensureScaledFixture,
  FIXTURE_GENERATOR_VERSION,
  isFixtureUnavailable,
  SMALL_FIXTURE,
  toScaledFixture,
} from '../../../test/bench/support/fixture-generator.ts';

// `rename` defaults to the real implementation for every test; only the two
// race tests override it (and restore it in a `finally`). The mock is file-wide
// (hoisted above every import), so the generator under test sees the same
// module and every other test still performs a genuine rename.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const HEX40 = /^[0-9a-f]{40}$/;
const NOT_PRISTINE_WARNING =
  '[bench] cached fixture "small" is not pristine: HEAD is detached, expected refs/heads/main. ' +
  'Rebuilding it. A bench mutated the shared cache — copy it first ' +
  '(test/bench/support/fixture-scratch.ts).\n';

// Same GIT_* scrub as fixture-generator.ts's own internal `gitEnv()` — a
// husky/parent `git` invocation can export GIT_DIR/GIT_WORK_TREE, which would
// silently redirect these spawned probes to the wrong repository.
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version'], { env: gitEnv() });
    return true;
  } catch {
    return false;
  }
};

const RUNNING_UNDER_STRYKER = process.env.STRYKER_MUTANT_ID !== undefined;
const HAS_GIT = hasGit();

const gitOut = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { env: gitEnv() })
    .toString()
    .trim();

const rootCommitOf = (cwd: string): string =>
  gitOut(cwd, ['rev-list', '--max-parents=0', 'refs/heads/main']);

const detachAtRoot = (cwd: string): void => {
  execFileSync('git', ['-C', cwd, 'checkout', '-q', '--detach', rootCommitOf(cwd)], {
    env: gitEnv(),
  });
};

const captureStderr = (): { readonly text: () => string; readonly restore: () => void } => {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    text: () => spy.mock.calls.map((call) => String(call[0])).join(''),
    restore: () => spy.mockRestore(),
  };
};

describe.skipIf(RUNNING_UNDER_STRYKER || !HAS_GIT)('ensureScaledFixture', () => {
  let originalXdgCacheHome: string | undefined;
  let isolatedCacheHome: string;

  beforeAll(async () => {
    originalXdgCacheHome = process.env.XDG_CACHE_HOME;
    isolatedCacheHome = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fixture-generator-test-'));
    process.env.XDG_CACHE_HOME = isolatedCacheHome;
  });

  afterAll(async () => {
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    await rm(isolatedCacheHome, { recursive: true, force: true });
  });

  describe('Given the small multi-file fixture spec', () => {
    describe('When ensureScaledFixture builds it', () => {
      it('Then it returns 40-hex ids backed by a packed cache dir', async () => {
        // Arrange
        const sut = ensureScaledFixture;

        // Act
        const result = await sut(SMALL_FIXTURE);

        // Assert
        expect(result.headCommitId).toMatch(HEX40);
        // `d0/f0.dat` is the multi generator's first blob (blobPath(0)); pin the
        // identity, not just the shape, so a wrong-but-valid oid cannot pass.
        const firstBlobOracle = execFileSync(
          'git',
          ['-C', result.cwd, 'rev-parse', 'HEAD:d0/f0.dat'],
          {
            env: gitEnv(),
          },
        )
          .toString()
          .trim();
        expect(firstBlobOracle).toMatch(HEX40);
        expect(result.firstBlobId).toBe(firstBlobOracle);
        const packDir = path.join(result.cwd, '.git', 'objects', 'pack');
        const packFiles = await readdir(packDir);
        expect(packFiles.some((file) => file.endsWith('.pack'))).toBe(true);
      });
    });
  });

  describe('Given the small deep-ancestry fixture spec', () => {
    describe('When ensureScaledFixture builds it', () => {
      it('Then stable.txt resolves at HEAD alongside 40-hex ids', async () => {
        // Arrange
        const sut = ensureScaledFixture;

        // Act
        const result = await sut(DEEP_ANCESTRY_SMALL);

        // Assert
        expect(result.headCommitId).toMatch(HEX40);
        // Pin firstBlobId to stable.txt's blob — this verifies the deep-ancestry
        // path-selection branch (stable.txt, not churn.txt or the head commit).
        const stableBlobId = execFileSync(
          'git',
          ['-C', result.cwd, 'rev-parse', 'HEAD:stable.txt'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        expect(stableBlobId).toMatch(HEX40);
        expect(result.firstBlobId).toBe(stableBlobId);
      });
    });
  });

  describe('Given a cached small fixture whose HEAD was detached at its root', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it rebuilds the fixture back onto refs/heads/main', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const rootCommitId = execFileSync(
          'git',
          ['-C', original.cwd, 'rev-list', '--max-parents=0', 'refs/heads/main'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        execFileSync('git', ['-C', original.cwd, 'checkout', '-q', '--detach', rootCommitId], {
          env: gitEnv(),
        });
        const sut = ensureScaledFixture;

        // Act
        const result = await sut(SMALL_FIXTURE);

        // Assert
        const headSymbolicName = execFileSync(
          'git',
          ['-C', result.cwd, 'rev-parse', '--symbolic-full-name', 'HEAD'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        expect(headSymbolicName).toBe('refs/heads/main');
        expect(result.headCommitId).toBe(original.headCommitId);
      });
    });
  });

  describe('Given a cached small fixture whose refs/heads/main was moved while HEAD stayed symbolic', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it rebuilds the fixture back onto the original commit', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const rootCommitId = execFileSync(
          'git',
          ['-C', original.cwd, 'rev-list', '--max-parents=0', 'refs/heads/main'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        execFileSync('git', ['-C', original.cwd, 'update-ref', 'refs/heads/main', rootCommitId], {
          env: gitEnv(),
        });
        const sut = ensureScaledFixture;

        // Act
        const result = await sut(SMALL_FIXTURE);

        // Assert
        const mainCommitId = execFileSync(
          'git',
          ['-C', result.cwd, 'rev-parse', 'refs/heads/main'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        expect(mainCommitId).toBe(original.headCommitId);
      });
    });
  });

  describe('Given a pristine cached small fixture carrying a sentinel file', () => {
    describe('When ensureScaledFixture resolves it twice', () => {
      it('Then the hit path returns the cache without rebuilding it', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const sentinelPath = path.join(original.cwd, 'sentinel.txt');
        await writeFile(sentinelPath, 'sentinel');
        const sut = ensureScaledFixture;

        // Act
        await sut(SMALL_FIXTURE);
        await sut(SMALL_FIXTURE);

        // Assert
        const sentinelContent = await readFile(sentinelPath, 'utf8');
        expect(sentinelContent).toBe('sentinel');
      });
    });
  });

  describe('Given a detached cached small fixture', () => {
    describe('When ensureScaledFixture rebuilds it', () => {
      it('Then it warns with the exact not-pristine message for a detached HEAD', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        detachAtRoot(original.cwd);
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let written: string;
        try {
          await sut(SMALL_FIXTURE);
          written = stderr.text();
        } finally {
          stderr.restore();
        }

        // Assert
        expect(written).toBe(NOT_PRISTINE_WARNING);
      });
    });
  });

  describe('Given a detached cached small fixture and no git reachable via PATH', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it reports the fixture unavailable and leaves the cache in place', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        detachAtRoot(original.cwd);
        const emptyPathDir = await mkdtemp(
          path.join(os.tmpdir(), 'tsgit-fixture-generator-test-empty-path-'),
        );
        const originalPath = process.env.PATH;
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let caught: unknown;
        try {
          process.env.PATH = emptyPathDir;
          await sut(SMALL_FIXTURE);
        } catch (err) {
          caught = err;
        } finally {
          stderr.restore();
          if (originalPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = originalPath;
          }
          await rm(emptyPathDir, { recursive: true, force: true });
        }

        // Assert
        expect(isFixtureUnavailable(caught)).toBe(true);
        expect((caught as Error).message).toBe(
          'scaled bench fixture unavailable: the `git` CLI is not on PATH',
        );
        // The mismatch was proven from the HEAD file, but nothing could rebuild it:
        // the cache is neither destroyed nor handed out.
        await expect(readFile(path.join(original.cwd, 'meta.json'), 'utf8')).resolves.toContain(
          original.headCommitId,
        );
        expect(gitOut(original.cwd, ['rev-parse', '--symbolic-full-name', 'HEAD'])).toBe('HEAD');
        // Leave the shared cache as this test found it: repaired, on refs/heads/main.
        const repairStderr = captureStderr();
        try {
          await ensureScaledFixture(SMALL_FIXTURE);
        } finally {
          repairStderr.restore();
        }
      });
    });
  });

  describe('Given a cached small fixture whose .git/HEAD holds garbage', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then the HEAD file itself proves the mismatch and the fixture is rebuilt', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const headPath = path.join(original.cwd, '.git', 'HEAD');
        await writeFile(headPath, 'garbage\n');
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        let written: string;
        try {
          result = await sut(SMALL_FIXTURE);
          written = stderr.text();
        } finally {
          stderr.restore();
        }

        // Assert
        expect(result.headCommitId).toBe(original.headCommitId);
        await expect(readFile(headPath, 'utf8')).resolves.toBe('ref: refs/heads/main\n');
        expect(written).toContain('is not pristine: HEAD is "garbage", expected refs/heads/main.');
      });
    });
  });

  describe('Given a cached small fixture whose .git/HEAD file is missing', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then the missing file proves the mismatch and the fixture is rebuilt', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const headPath = path.join(original.cwd, '.git', 'HEAD');
        await rm(headPath, { force: true });
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        let written: string;
        try {
          result = await sut(SMALL_FIXTURE);
          written = stderr.text();
        } finally {
          stderr.restore();
        }

        // Assert
        expect(result.headCommitId).toBe(original.headCommitId);
        await expect(readFile(headPath, 'utf8')).resolves.toBe('ref: refs/heads/main\n');
        expect(written).toContain('is not pristine: HEAD file is unreadable: ');
      });
    });
  });

  describe('Given a cached small fixture whose .git/config git refuses to parse', () => {
    describe('When ensureScaledFixture resolves it with git present', () => {
      it('Then it keeps the cache untouched and warns that it could not be verified', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const configPath = path.join(original.cwd, '.git', 'config');
        const originalConfig = await readFile(configPath, 'utf8');
        await writeFile(configPath, '[core\n');
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        let written: string;
        try {
          result = await sut(SMALL_FIXTURE);
          written = stderr.text();
        } finally {
          stderr.restore();
          // Leave the shared cache as this test found it.
          await writeFile(configPath, originalConfig);
        }

        // Assert
        expect(result.headCommitId).toBe(original.headCommitId);
        await expect(readFile(configPath, 'utf8')).resolves.toBe(originalConfig);
        expect(written).toContain('[bench] cached fixture "small" could not be verified: ');
        expect(written).toContain(
          `Keeping it — a mismatch is never assumed; delete ${original.cwd} to force a rebuild.`,
        );
        expect(written).not.toContain('Rebuilding it');
      });
    });
  });

  describe('Given a GIT_DIR in the environment that names another repository', () => {
    describe('When ensureScaledFixture resolves the small fixture', () => {
      it('Then the probe answers about the cache itself and nothing is rebuilt', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const sentinelPath = path.join(original.cwd, 'sentinel.txt');
        await writeFile(sentinelPath, 'sentinel');
        const decoy = await mkdtemp(path.join(isolatedCacheHome, 'decoy-'));
        execFileSync('git', ['init', '-q', '--initial-branch=main', decoy], { env: gitEnv() });
        execFileSync(
          'git',
          [
            '-C',
            decoy,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'decoy',
          ],
          { env: gitEnv() },
        );
        const originalGitDir = process.env.GIT_DIR;
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        let written: string;
        try {
          process.env.GIT_DIR = path.join(decoy, '.git');
          result = await sut(SMALL_FIXTURE);
          written = stderr.text();
        } finally {
          stderr.restore();
          if (originalGitDir === undefined) {
            delete process.env.GIT_DIR;
          } else {
            process.env.GIT_DIR = originalGitDir;
          }
          await rm(decoy, { recursive: true, force: true });
        }

        // Assert
        expect(result.headCommitId).toBe(original.headCommitId);
        await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('sentinel');
        expect(written).toBe('');
      });
    });
  });

  describe('Given a cached small fixture whose refs/heads/main was deleted', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it treats the missing ref as a proven mismatch and rebuilds', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        execFileSync('git', ['-C', original.cwd, 'update-ref', '-d', 'refs/heads/main'], {
          env: gitEnv(),
        });
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        let written: string;
        try {
          result = await sut(SMALL_FIXTURE);
          written = stderr.text();
        } finally {
          stderr.restore();
        }

        // Assert
        expect(gitOut(result.cwd, ['rev-parse', 'refs/heads/main'])).toBe(original.headCommitId);
        expect(written).toContain(
          `is not pristine: refs/heads/main is missing, expected ${original.headCommitId}.`,
        );
      });
    });
  });

  describe('Given a populated cache directory whose meta.json was deleted', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it rebuilds the same fixture instead of failing on ENOTEMPTY', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        const metaPath = path.join(original.cwd, 'meta.json');
        await rm(metaPath, { force: true });
        const sut = ensureScaledFixture;

        // Act
        const result = await sut(SMALL_FIXTURE);

        // Assert
        expect(result.headCommitId).toBe(original.headCommitId);
        await expect(readFile(metaPath, 'utf8')).resolves.toContain(original.headCommitId);
      });
    });
  });

  describe('Given a cached small fixture resolved, detached, and resolved again', () => {
    describe('When ensureScaledFixture repairs it', () => {
      it('Then the cache root has no leftover corrupt or temp directories', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        detachAtRoot(original.cwd);
        const sut = ensureScaledFixture;

        // Act
        await sut(SMALL_FIXTURE);

        // Assert
        const cacheRootEntries = await readdir(path.dirname(original.cwd));
        const leftovers = cacheRootEntries.filter(
          (entry) => entry.includes('.corrupt.') || entry.includes('.tmp.'),
        );
        expect(leftovers).toEqual([]);
      });
    });
  });

  /** Simulates another process winning the build race: its cache lands at the
   *  target first (`cp`), so this process's `rename` fails on the occupied path. */
  const loseTheRenameRace = async (
    cacheDir: string,
    onWinnerLanded: (winnerDir: string) => void,
  ): Promise<() => void> => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const mockedRename = vi.mocked(rename);
    mockedRename.mockImplementation(async (from, to) => {
      if (String(to) !== cacheDir) return actualFs.rename(from, to);
      await actualFs.cp(String(from), String(to), { recursive: true });
      onWinnerLanded(String(to));
      throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
    });
    return () => mockedRename.mockImplementation(actualFs.rename);
  };

  /** The build's final rename fails and nothing lands at the target — the plain build-failure path. */
  const failTheFinalRename = async (cacheDir: string): Promise<() => void> => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const mockedRename = vi.mocked(rename);
    mockedRename.mockImplementation(async (from, to) => {
      if (String(to) !== cacheDir) return actualFs.rename(from, to);
      throw new Error('EIO: simulated rename failure');
    });
    return () => mockedRename.mockImplementation(actualFs.rename);
  };

  describe('Given a build that loses the rename race to a pristine winner', () => {
    describe('When ensureScaledFixture recovers', () => {
      it('Then it reuses the winner and leaves no temp build behind', async () => {
        // Arrange
        const cacheDir = (await ensureScaledFixture(SMALL_FIXTURE)).cwd;
        await rm(cacheDir, { recursive: true, force: true });
        const restoreRename = await loseTheRenameRace(cacheDir, () => undefined);
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        try {
          result = await sut(SMALL_FIXTURE);
        } finally {
          restoreRename();
        }

        // Assert
        const winnerMeta = JSON.parse(await readFile(path.join(cacheDir, 'meta.json'), 'utf8'));
        expect(result.headCommitId).toBe(winnerMeta.headCommitId);
        const leftovers = (await readdir(path.dirname(cacheDir))).filter((entry) =>
          entry.includes('.tmp.'),
        );
        expect(leftovers).toEqual([]);
      });
    });
  });

  describe('Given a build that loses the rename race to a non-pristine winner', () => {
    describe('When ensureScaledFixture recovers', () => {
      it('Then it rethrows the original build error after warning', async () => {
        // Arrange
        const cacheDir = (await ensureScaledFixture(SMALL_FIXTURE)).cwd;
        await rm(cacheDir, { recursive: true, force: true });
        const restoreRename = await loseTheRenameRace(cacheDir, (winnerDir) =>
          detachAtRoot(winnerDir),
        );
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let caught: unknown;
        let written: string;
        try {
          await sut(SMALL_FIXTURE);
        } catch (err) {
          caught = err;
        } finally {
          written = stderr.text();
          stderr.restore();
          restoreRename();
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('ENOTEMPTY: directory not empty');
        expect(written).toBe(NOT_PRISTINE_WARNING);
        // Leave the shared cache as this test found it: the detached winner is repaired.
        const repairStderr = captureStderr();
        try {
          await ensureScaledFixture(SMALL_FIXTURE);
        } finally {
          repairStderr.restore();
        }
      });
    });
  });
  describe('Given a build whose final rename fails with nothing at the target', () => {
    describe('When ensureScaledFixture recovers', () => {
      it('Then the original build error surfaces and nothing is written to stderr', async () => {
        // Arrange
        const cacheDir = (await ensureScaledFixture(SMALL_FIXTURE)).cwd;
        await rm(cacheDir, { recursive: true, force: true });
        const restoreRename = await failTheFinalRename(cacheDir);
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let caught: unknown;
        let written: string;
        try {
          await sut(SMALL_FIXTURE);
        } catch (err) {
          caught = err;
        } finally {
          written = stderr.text();
          stderr.restore();
          restoreRename();
        }

        // Assert
        expect((caught as Error).message).toBe('EIO: simulated rename failure');
        expect(written).toBe('');
      });
    });
  });

  describe('Given a build that loses the rename race to a winner git cannot verify', () => {
    describe('When ensureScaledFixture recovers', () => {
      it('Then it rethrows the original build error without calling the winner corrupt', async () => {
        // Arrange
        const cacheDir = (await ensureScaledFixture(SMALL_FIXTURE)).cwd;
        await rm(cacheDir, { recursive: true, force: true });
        const restoreRename = await loseTheRenameRace(cacheDir, (winnerDir) => {
          writeFileSync(path.join(winnerDir, '.git', 'config'), '[core\n');
        });
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let caught: unknown;
        let written: string;
        try {
          await sut(SMALL_FIXTURE);
        } catch (err) {
          caught = err;
        } finally {
          written = stderr.text();
          stderr.restore();
          restoreRename();
          // Leave no unverifiable cache behind for the next test: it cold-builds.
          await rm(cacheDir, { recursive: true, force: true });
        }

        // Assert
        expect((caught as Error).message).toBe('ENOTEMPTY: directory not empty');
        expect(written).not.toContain('is not pristine');
      });
    });
  });

  describe('Given a failed build whose temp directory also refuses to be removed', () => {
    describe('When ensureScaledFixture discards the temp build', () => {
      it('Then the build error still surfaces and the cleanup failure is reported', async () => {
        // Arrange
        const cacheDir = (await ensureScaledFixture(SMALL_FIXTURE)).cwd;
        await rm(cacheDir, { recursive: true, force: true });
        const restoreRename = await failTheFinalRename(cacheDir);
        const actualFs =
          await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const mockedRm = vi.mocked(rm);
        mockedRm.mockImplementation(async (target, options) => {
          if (String(target).includes('.tmp.')) throw new Error('EBUSY: simulated rm failure');
          return actualFs.rm(target, options);
        });
        const stderr = captureStderr();
        const sut = ensureScaledFixture;

        // Act
        let caught: unknown;
        let written: string;
        try {
          await sut(SMALL_FIXTURE);
        } catch (err) {
          caught = err;
        } finally {
          written = stderr.text();
          stderr.restore();
          restoreRename();
          mockedRm.mockImplementation(actualFs.rm);
          for (const entry of await readdir(path.dirname(cacheDir))) {
            if (entry.includes('.tmp.')) {
              await actualFs.rm(path.join(path.dirname(cacheDir), entry), {
                recursive: true,
                force: true,
              });
            }
          }
        }

        // Assert
        expect((caught as Error).message).toBe('EIO: simulated rename failure');
        expect(written).toContain('[bench] could not remove ');
        expect(written).toContain('EBUSY: simulated rm failure');
      });
    });
  });
});

describe('toScaledFixture', () => {
  const headCommitId = 'a'.repeat(40);
  const firstBlobId = 'b'.repeat(40);

  describe('Given a fixture meta without a last blob id', () => {
    describe('When toScaledFixture shapes it', () => {
      it('Then the result carries no lastBlobId key at all', () => {
        // Arrange
        const meta = {
          version: FIXTURE_GENERATOR_VERSION,
          headCommitId,
          firstBlobId,
          spec: SMALL_FIXTURE,
        };
        const sut = toScaledFixture;

        // Act
        const result = sut('/cache/small-v3', meta, SMALL_FIXTURE);

        // Assert
        expect(Object.hasOwn(result, 'lastBlobId')).toBe(false);
        expect(result).toEqual({
          cwd: '/cache/small-v3',
          headCommitId,
          firstBlobId,
          spec: SMALL_FIXTURE,
        });
      });
    });
  });

  describe('Given a fixture meta with a last blob id', () => {
    describe('When toScaledFixture shapes it', () => {
      it('Then the result carries that lastBlobId', () => {
        // Arrange
        const lastBlobId = 'c'.repeat(40);
        const meta = {
          version: FIXTURE_GENERATOR_VERSION,
          headCommitId,
          firstBlobId,
          lastBlobId,
          spec: SMALL_FIXTURE,
        };
        const sut = toScaledFixture;

        // Act
        const result = sut('/cache/small-v3', meta, SMALL_FIXTURE);

        // Assert
        expect(Object.hasOwn(result, 'lastBlobId')).toBe(true);
        expect(result.lastBlobId).toBe(lastBlobId);
      });
    });
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEEP_ANCESTRY_SMALL,
  ensureScaledFixture,
  SMALL_FIXTURE,
} from '../../../test/bench/support/fixture-generator.ts';

const HEX40 = /^[0-9a-f]{40}$/;

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
      it('Then it warns naming the label, the expected ref, and the observed HEAD', async () => {
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
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const sut = ensureScaledFixture;

        // Act
        await sut(SMALL_FIXTURE);

        // Assert
        const written = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
        stderrSpy.mockRestore();
        expect(written).toContain('small');
        expect(written).toContain('refs/heads/main');
        expect(written).toContain('HEAD');
      });
    });
  });

  describe('Given a detached cached small fixture and no git reachable via PATH', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it degrades to the cached fixture without rebuilding or throwing', async () => {
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
        const emptyPathDir = await mkdtemp(
          path.join(os.tmpdir(), 'tsgit-fixture-generator-test-empty-path-'),
        );
        const originalPath = process.env.PATH;
        const sut = ensureScaledFixture;

        // Act
        let result: Awaited<ReturnType<typeof ensureScaledFixture>>;
        try {
          process.env.PATH = emptyPathDir;
          result = await sut(SMALL_FIXTURE);
        } finally {
          if (originalPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = originalPath;
          }
          await rm(emptyPathDir, { recursive: true, force: true });
        }

        // Assert
        expect(result.headCommitId).toBe(original.headCommitId);
        const headSymbolicName = execFileSync(
          'git',
          ['-C', result.cwd, 'rev-parse', '--symbolic-full-name', 'HEAD'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        expect(headSymbolicName).toBe('HEAD');
      });
    });
  });

  describe('Given a populated cache directory whose meta.json was deleted', () => {
    describe('When ensureScaledFixture resolves it', () => {
      it('Then it rebuilds the fixture instead of failing on ENOTEMPTY', async () => {
        // Arrange
        const original = await ensureScaledFixture(SMALL_FIXTURE);
        await rm(path.join(original.cwd, 'meta.json'), { force: true });
        const sut = ensureScaledFixture;

        // Act
        const result = await sut(SMALL_FIXTURE);

        // Assert
        expect(result.headCommitId).toMatch(HEX40);
      });
    });
  });

  describe('Given a cached small fixture resolved, detached, and resolved again', () => {
    describe('When ensureScaledFixture repairs it', () => {
      it('Then the cache root has no leftover corrupt or temp directories', async () => {
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
});

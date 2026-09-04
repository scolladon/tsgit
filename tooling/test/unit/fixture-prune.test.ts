import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Builds a cache-root-shaped directory with N files of exact byte length, so
 *  byte assertions below are exact rather than approximate. */
const buildCacheDir = async (
  root: string,
  name: string,
  fileBytes: readonly number[],
): Promise<string> => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    fileBytes.map((bytes, index) => writeFile(path.join(dir, `f${index}.dat`), 'x'.repeat(bytes))),
  );
  return dir;
};

// `rm` defaults to the real implementation for every test; only the one test
// that exercises the failure path overrides it, and restores it afterward.
// This mock is file-wide (vi.mock is hoisted above every import in this
// file), so every other test's `pruneFixtureCache()` call and this file's own
// `afterEach` teardown still perform a genuine removal.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const { pruneFixtureCache } = await import('../../../test/bench/support/fixture-prune.ts');

describe('pruneFixtureCache', () => {
  let originalXdgCacheHome: string | undefined;
  let isolatedCacheHome: string;

  beforeEach(async () => {
    originalXdgCacheHome = process.env.XDG_CACHE_HOME;
    isolatedCacheHome = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fixture-prune-test-'));
    process.env.XDG_CACHE_HOME = isolatedCacheHome;
  });

  afterEach(async () => {
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    await rm(isolatedCacheHome, { recursive: true, force: true });
  });

  describe('Given a cache root holding a stale-version directory with two files of known size', () => {
    describe('When pruneFixtureCache prunes it', () => {
      it('Then the directory is removed and its bytes are reported exactly', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const staleDir = await buildCacheDir(root, 'medium-v2', [10, 15]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        await expect(readdir(root)).resolves.not.toContain('medium-v2');
        const removedEntry = result.removed.find((entry) => entry.path === staleDir);
        expect(removedEntry?.bytes).toBe(25);
      });
    });
  });

  describe('Given a cache root holding the current-version directory', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then the directory and its files survive, and nothing is reported removed', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const currentDir = await buildCacheDir(root, 'medium-v3', [10]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        await expect(readdir(root)).resolves.toContain('medium-v3');
        await expect(readdir(currentDir)).resolves.toContain('f0.dat');
        expect(result.removed).toEqual([]);
      });
    });
  });

  describe('Given a cache root holding a `.tmp.` leftover from an interrupted build', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then the leftover is removed', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const leftoverDir = await buildCacheDir(root, 'medium-v3.tmp.123.1700000000000', [5]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        await expect(readdir(root)).resolves.not.toContain('medium-v3.tmp.123.1700000000000');
        expect(result.removed.some((entry) => entry.path === leftoverDir)).toBe(true);
      });
    });
  });

  describe('Given a cache root holding a `.corrupt.` leftover from a failed identity probe', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then the leftover is removed', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const leftoverDir = await buildCacheDir(root, 'medium-v3.corrupt.123.1700000000000', [5]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        await expect(readdir(root)).resolves.not.toContain('medium-v3.corrupt.123.1700000000000');
        expect(result.removed.some((entry) => entry.path === leftoverDir)).toBe(true);
      });
    });
  });

  describe('Given a cache root holding a directory whose label is not a known fixture label', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then it is kept even though it matches the version-number shape', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const unknownDir = await buildCacheDir(root, 'not-a-fixture-v1', [5]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        await expect(readdir(root)).resolves.toContain('not-a-fixture-v1');
        await expect(readdir(unknownDir)).resolves.toContain('f0.dat');
        expect(result.removed).toEqual([]);
      });
    });
  });

  describe('Given a cache root holding a plain file and an unrelated directory', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then both survive and nothing is reported removed', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, 'notes.txt'), 'keep me');
        const scratchDir = await buildCacheDir(root, 'scratch', [3]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        const rootEntries = await readdir(root);
        expect(rootEntries).toEqual(expect.arrayContaining(['notes.txt', 'scratch']));
        await expect(readdir(scratchDir)).resolves.toContain('f0.dat');
        expect(result.removed).toEqual([]);
      });
    });
  });

  describe('Given an empty cache root', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then the report is empty and the root itself still exists', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        await mkdir(root, { recursive: true });
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        expect(result).toEqual({ root, removed: [], failed: [] });
        await expect(readdir(root)).resolves.toEqual([]);
      });
    });
  });

  describe('Given no cache root at all', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then it resolves an empty report instead of throwing', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        expect(result).toEqual({ root, removed: [], failed: [] });
      });
    });
  });

  describe('Given two stale-version directories of different known sizes', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then each reported byte count is exact and the sum matches what was written', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        await buildCacheDir(root, 'small-v1', [7]);
        await buildCacheDir(root, 'large-v2', [11, 13]);
        const sut = pruneFixtureCache;

        // Act
        const result = await sut();

        // Assert
        const bySmall = result.removed.find((entry) => entry.path.endsWith('small-v1'));
        const byLarge = result.removed.find((entry) => entry.path.endsWith('large-v2'));
        expect(bySmall?.bytes).toBe(7);
        expect(byLarge?.bytes).toBe(24);
        const total = result.removed.reduce((sum, entry) => sum + entry.bytes, 0);
        expect(total).toBe(31);
      });
    });
  });

  describe('Given two stale directories where one fails to be removed', () => {
    describe('When pruneFixtureCache runs', () => {
      it('Then the other is removed, the failure carries its path and reason, and the failed directory is absent from removed', async () => {
        // Arrange
        const root = path.join(isolatedCacheHome, 'tsgit-bench');
        const okDir = await buildCacheDir(root, 'small-v1', [4]);
        const failDir = await buildCacheDir(root, 'large-v1', [6]);
        const actualFs =
          await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const mockedRm = vi.mocked(rm);
        mockedRm.mockImplementation(async (target, options) =>
          target === failDir
            ? Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
            : actualFs.rm(target, options),
        );
        const sut = pruneFixtureCache;

        // Act
        let result: Awaited<ReturnType<typeof pruneFixtureCache>>;
        try {
          result = await sut();
        } finally {
          mockedRm.mockImplementation(actualFs.rm);
        }

        // Assert
        await expect(readdir(root)).resolves.not.toContain('small-v1');
        await expect(readdir(root)).resolves.toContain('large-v1');
        expect(result.removed.some((entry) => entry.path === okDir)).toBe(true);
        expect(result.removed.some((entry) => entry.path === failDir)).toBe(false);
        const failure = result.failed.find((entry) => entry.path === failDir);
        expect(failure).toEqual({ path: failDir, reason: 'permission denied' });
      });
    });
  });

  describe('Given a symlink at the cache root named like a stale directory', () => {
    describe('When pruneFixtureCache runs', () => {
      it.skipIf(process.platform === 'win32')(
        'Then the link and its target both survive and nothing is reported removed',
        async () => {
          // Arrange
          const root = path.join(isolatedCacheHome, 'tsgit-bench');
          const targetDir = await buildCacheDir(isolatedCacheHome, 'link-target', [4]);
          await mkdir(root, { recursive: true });
          const linkPath = path.join(root, 'small-v1');
          await symlink(targetDir, linkPath, 'dir');
          const sut = pruneFixtureCache;

          // Act
          const result = await sut();

          // Assert
          await expect(readdir(root)).resolves.toContain('small-v1');
          await expect(readdir(targetDir)).resolves.toContain('f0.dat');
          expect(result.removed).toEqual([]);
        },
      );
    });
  });
});

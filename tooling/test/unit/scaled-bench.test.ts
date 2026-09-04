/**
 * Unit coverage for `resolveScaledContext`'s exception narrowing
 * (`test/bench/support/scaled-bench.ts`): an absent `git` still resolves a
 * fixture-less context, the Stryker sandbox short-circuits before the
 * generator ever runs, and every other rejection reaches the caller instead
 * of vanishing into a silent skip.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../test/bench/support/fixture-generator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../test/bench/support/fixture-generator.js')>();
  return { ...actual, ensureScaledFixture: vi.fn(actual.ensureScaledFixture) };
});

const { ensureScaledFixture, SMALL_FIXTURE } = await import(
  '../../../test/bench/support/fixture-generator.js'
);
const { resolveScaledContext } = await import('../../../test/bench/support/scaled-bench.js');

const mockedEnsureScaledFixture = vi.mocked(ensureScaledFixture);

describe.skipIf(process.env.STRYKER_MUTANT_ID !== undefined)('resolveScaledContext', () => {
  afterEach(() => {
    mockedEnsureScaledFixture.mockClear();
  });

  describe('Given an empty cache root and no git on PATH', () => {
    describe('When resolveScaledContext resolves the small fixture', () => {
      it('Then it returns a fixture-less context', async () => {
        // Arrange
        const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        const originalPath = process.env.PATH;
        const emptyCacheHome = await mkdtemp(path.join(os.tmpdir(), 'tsgit-scaled-bench-cache-'));
        const emptyPathDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-scaled-bench-path-'));
        const sut = resolveScaledContext;

        // Act
        let result: Awaited<ReturnType<typeof resolveScaledContext>>;
        try {
          process.env.XDG_CACHE_HOME = emptyCacheHome;
          process.env.PATH = emptyPathDir;
          result = await sut(SMALL_FIXTURE);
        } finally {
          if (originalXdgCacheHome === undefined) {
            delete process.env.XDG_CACHE_HOME;
          } else {
            process.env.XDG_CACHE_HOME = originalXdgCacheHome;
          }
          if (originalPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = originalPath;
          }
          await rm(emptyCacheHome, { recursive: true, force: true });
          await rm(emptyPathDir, { recursive: true, force: true });
        }

        // Assert
        expect(result.fixture).toBeUndefined();
        expect(result.given).toBe('Given a small repo (50 commits, 200 blobs)');
        expect(mockedEnsureScaledFixture).toHaveBeenCalled();
      });
    });
  });

  describe('Given ensureScaledFixture rejecting with a non-fixture error', () => {
    describe('When resolveScaledContext resolves the small fixture', () => {
      it('Then it rejects with the original error message', async () => {
        // Arrange
        mockedEnsureScaledFixture.mockRejectedValueOnce(
          new Error('git fast-import exited with 128'),
        );
        const sut = resolveScaledContext;

        // Act
        let caught: unknown;
        try {
          await sut(SMALL_FIXTURE);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as Error).message).toBe('git fast-import exited with 128');
      });
    });
  });

  describe('Given the Stryker sandbox and a rejecting ensureScaledFixture', () => {
    describe('When resolveScaledContext resolves the small fixture', () => {
      it('Then it short-circuits without calling the fixture generator', async () => {
        // Arrange
        const originalMutantId = process.env.STRYKER_MUTANT_ID;
        mockedEnsureScaledFixture.mockRejectedValueOnce(new Error('should never run'));
        const sut = resolveScaledContext;

        // Act
        let result: Awaited<ReturnType<typeof resolveScaledContext>>;
        try {
          process.env.STRYKER_MUTANT_ID = '1';
          result = await sut(SMALL_FIXTURE);
        } finally {
          if (originalMutantId === undefined) {
            delete process.env.STRYKER_MUTANT_ID;
          } else {
            process.env.STRYKER_MUTANT_ID = originalMutantId;
          }
        }

        // Assert
        expect(result.fixture).toBeUndefined();
        expect(mockedEnsureScaledFixture).not.toHaveBeenCalled();
      });
    });
  });
});

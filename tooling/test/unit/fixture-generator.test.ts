import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
        expect(result.firstBlobId).toMatch(HEX40);
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
        expect(result.firstBlobId).toMatch(HEX40);
        const stableBlobId = execFileSync(
          'git',
          ['-C', result.cwd, 'rev-parse', 'HEAD:stable.txt'],
          { env: gitEnv() },
        )
          .toString()
          .trim();
        expect(stableBlobId).toMatch(HEX40);
      });
    });
  });
});

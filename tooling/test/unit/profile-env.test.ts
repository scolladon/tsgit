import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { profileEnv, withPinnedDate } from '../../profile-env.js';

describe('profileEnv', () => {
  describe('Given process.env carries a GIT_DIR', () => {
    const originalGitDir = process.env.GIT_DIR;

    beforeEach(() => {
      process.env.GIT_DIR = '/tmp/some-repo/.git';
    });

    afterEach(() => {
      if (originalGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = originalGitDir;
      }
    });

    describe('When profileEnv() runs', () => {
      it('Then the result has no GIT_DIR key', () => {
        // Arrange
        const sut = profileEnv;

        // Act
        const result = sut();

        // Assert
        expect('GIT_DIR' in result).toBe(false);
      });
    });
  });

  describe('Given process.env carries a non-GIT key', () => {
    const SENTINEL = 'TSGIT_PROFILE_SENTINEL';
    const originalSentinel = process.env[SENTINEL];

    beforeEach(() => {
      process.env[SENTINEL] = 'keep-me';
    });

    afterEach(() => {
      if (originalSentinel === undefined) {
        delete process.env[SENTINEL];
      } else {
        process.env[SENTINEL] = originalSentinel;
      }
    });

    describe('When profileEnv() runs', () => {
      it('Then the non-GIT key survives (only GIT_* is scrubbed, not the whole env)', () => {
        // Arrange
        const sut = profileEnv;

        // Act
        const result = sut();

        // Assert — a mutant that scrubbed the whole env (then re-pinned the GIT_
        // identity) would drop this; proving it survives pins the GIT_-only scrub.
        expect(result[SENTINEL]).toBe('keep-me');
      });
    });
  });

  describe('Given any process.env', () => {
    describe('When profileEnv() runs', () => {
      it('Then GIT_AUTHOR_NAME/EMAIL, GIT_COMMITTER_NAME/EMAIL are the pinned profile identity and GIT_CONFIG_NOSYSTEM is 1', () => {
        // Arrange
        const sut = profileEnv;

        // Act
        const result = sut();

        // Assert
        expect(result.GIT_AUTHOR_NAME).toBe('profile');
        expect(result.GIT_AUTHOR_EMAIL).toBe('profile@tsgit.invalid');
        expect(result.GIT_COMMITTER_NAME).toBe('profile');
        expect(result.GIT_COMMITTER_EMAIL).toBe('profile@tsgit.invalid');
        expect(result.GIT_CONFIG_NOSYSTEM).toBe('1');
      });
    });
  });
});

describe('withPinnedDate', () => {
  describe('Given a base env and an epoch', () => {
    describe('When withPinnedDate(env, 1700000000) runs', () => {
      it('Then GIT_AUTHOR_DATE and GIT_COMMITTER_DATE are 1700000000 +0000 and the base keys survive', () => {
        // Arrange
        const sut = withPinnedDate;
        const baseEnv = profileEnv();

        // Act
        const result = sut(baseEnv, 1_700_000_000);

        // Assert
        expect(result.GIT_AUTHOR_DATE).toBe('1700000000 +0000');
        expect(result.GIT_COMMITTER_DATE).toBe('1700000000 +0000');
        expect(result.GIT_CONFIG_NOSYSTEM).toBe(baseEnv.GIT_CONFIG_NOSYSTEM);
      });
    });
  });
});

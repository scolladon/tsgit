import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import type { LogAllRefUpdates } from '../../../../src/domain/reflog/should-log.js';
import { shouldAutocreateReflog } from '../../../../src/domain/reflog/should-log.js';

const HEAD = 'HEAD' as RefName;
const BRANCH = 'refs/heads/main' as RefName;
const REMOTE = 'refs/remotes/origin/main' as RefName;
const NOTE = 'refs/notes/commits' as RefName;
const TAG = 'refs/tags/v1.0.0' as RefName;

describe('shouldAutocreateReflog', () => {
  describe("logAllRefUpdates: 'always'", () => {
    describe("Given 'always'", () => {
      describe('When the ref is a tag', () => {
        it('Then logs (every ref logs under always)', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: 'always' };

          // Act
          const sut = shouldAutocreateReflog(TAG, cfg);

          // Assert
          expect(sut).toBe(true);
        });
      });
      describe('When the ref is a branch', () => {
        it('Then logs', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: 'always' };

          // Act & Assert
          expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
        });
      });
    });

    describe("Given 'always' on a bare repo", () => {
      describe('When the ref is a tag', () => {
        it('Then still logs', () => {
          // Arrange — `always` overrides the bare default.
          const cfg: LogAllRefUpdates = { logAllRefUpdates: 'always', bare: true };

          // Act & Assert
          expect(shouldAutocreateReflog(TAG, cfg)).toBe(true);
        });
      });
    });
  });

  describe('logAllRefUpdates: false', () => {
    describe('Given false', () => {
      describe('When the ref is HEAD', () => {
        it('Then does not log', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: false };

          // Act
          const sut = shouldAutocreateReflog(HEAD, cfg);

          // Assert
          expect(sut).toBe(false);
        });
      });
      describe('When the ref is a branch', () => {
        it('Then does not log', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: false };

          // Act & Assert
          expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(false);
        });
      });
    });
  });

  describe('logAllRefUpdates: true', () => {
    describe('Given true', () => {
      describe('When the ref is HEAD', () => {
        it('Then logs', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: true };

          // Act & Assert
          expect(shouldAutocreateReflog(HEAD, cfg)).toBe(true);
        });
      });
    });

    describe('Given true on a bare repo', () => {
      describe('When the ref is a branch', () => {
        it('Then still logs (true overrides bare)', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: true, bare: true };

          // Act & Assert
          expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
        });
      });
    });

    describe('Given true', () => {
      describe('When the ref is a tag', () => {
        it('Then does not log (tags are not default-loggable)', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: true };

          // Act & Assert
          expect(shouldAutocreateReflog(TAG, cfg)).toBe(false);
        });
      });
    });
  });

  describe('logAllRefUpdates unset', () => {
    describe('Given unset on a non-bare repo', () => {
      describe('When the ref is a branch', () => {
        it('Then logs', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { bare: false };

          // Act & Assert
          expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
        });
      });
    });

    describe('Given unset on a bare repo', () => {
      describe('When the ref is a branch', () => {
        it('Then does not log', () => {
          // Arrange
          const cfg: LogAllRefUpdates = { bare: true };

          // Act & Assert
          expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(false);
        });
      });
    });

    describe('Given an empty config (unset, unset)', () => {
      describe('When the ref is a branch', () => {
        it('Then logs (bare defaults to false)', () => {
          // Arrange
          const cfg: LogAllRefUpdates = {};

          // Act & Assert
          expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
        });
      });
    });
  });

  describe('default-loggable prefixes (logAllRefUpdates true)', () => {
    const cfg: LogAllRefUpdates = { logAllRefUpdates: true };

    describe('Given true', () => {
      describe('When the ref is HEAD', () => {
        it('Then logs', () => {
          // Arrange
          const sut = shouldAutocreateReflog(HEAD, cfg);

          // Assert
          expect(sut).toBe(true);
        });
      });
      describe('When the ref is under refs/heads/', () => {
        it('Then logs', () => {
          // Arrange
          const sut = shouldAutocreateReflog(BRANCH, cfg);

          // Assert
          expect(sut).toBe(true);
        });
      });
      describe('When the ref is under refs/remotes/', () => {
        it('Then logs', () => {
          // Arrange
          const sut = shouldAutocreateReflog(REMOTE, cfg);

          // Assert
          expect(sut).toBe(true);
        });
      });
      describe('When the ref is under refs/notes/', () => {
        it('Then logs', () => {
          // Arrange
          const sut = shouldAutocreateReflog(NOTE, cfg);

          // Assert
          expect(sut).toBe(true);
        });
      });
      describe('When the ref is under refs/tags/', () => {
        it('Then does not log', () => {
          // Arrange
          const sut = shouldAutocreateReflog(TAG, cfg);

          // Assert
          expect(sut).toBe(false);
        });
      });
      describe('When the ref is an unknown pseudo-ref', () => {
        it('Then does not log', () => {
          // Arrange
          const sut = shouldAutocreateReflog('FETCH_HEAD' as RefName, cfg);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });
  });
});

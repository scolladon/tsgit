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
    it("Given 'always', When the ref is a tag, Then logs (every ref logs under always)", () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: 'always' };

      // Act
      const sut = shouldAutocreateReflog(TAG, cfg);

      // Assert
      expect(sut).toBe(true);
    });

    it("Given 'always', When the ref is a branch, Then logs", () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: 'always' };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
    });

    it("Given 'always' on a bare repo, When the ref is a tag, Then still logs", () => {
      // Arrange — `always` overrides the bare default.
      const cfg: LogAllRefUpdates = { logAllRefUpdates: 'always', bare: true };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(TAG, cfg)).toBe(true);
    });
  });

  describe('logAllRefUpdates: false', () => {
    it('Given false, When the ref is HEAD, Then does not log', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: false };

      // Act
      const sut = shouldAutocreateReflog(HEAD, cfg);

      // Assert
      expect(sut).toBe(false);
    });

    it('Given false, When the ref is a branch, Then does not log', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: false };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(false);
    });
  });

  describe('logAllRefUpdates: true', () => {
    it('Given true, When the ref is HEAD, Then logs', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: true };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(HEAD, cfg)).toBe(true);
    });

    it('Given true on a bare repo, When the ref is a branch, Then still logs (true overrides bare)', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: true, bare: true };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
    });

    it('Given true, When the ref is a tag, Then does not log (tags are not default-loggable)', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { logAllRefUpdates: true };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(TAG, cfg)).toBe(false);
    });
  });

  describe('logAllRefUpdates unset', () => {
    it('Given unset on a non-bare repo, When the ref is a branch, Then logs', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { bare: false };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
    });

    it('Given unset on a bare repo, When the ref is a branch, Then does not log', () => {
      // Arrange
      const cfg: LogAllRefUpdates = { bare: true };

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(false);
    });

    it('Given an empty config (unset, unset), When the ref is a branch, Then logs (bare defaults to false)', () => {
      // Arrange
      const cfg: LogAllRefUpdates = {};

      // Act & Assert
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
    });
  });

  describe('default-loggable prefixes (logAllRefUpdates true)', () => {
    const cfg: LogAllRefUpdates = { logAllRefUpdates: true };

    it('Given true, When the ref is HEAD, Then logs', () => {
      // Arrange
      // Assert
      expect(shouldAutocreateReflog(HEAD, cfg)).toBe(true);
    });

    it('Given true, When the ref is under refs/heads/, Then logs', () => {
      // Arrange
      // Assert
      expect(shouldAutocreateReflog(BRANCH, cfg)).toBe(true);
    });

    it('Given true, When the ref is under refs/remotes/, Then logs', () => {
      // Arrange
      // Assert
      expect(shouldAutocreateReflog(REMOTE, cfg)).toBe(true);
    });

    it('Given true, When the ref is under refs/notes/, Then logs', () => {
      // Arrange
      // Assert
      expect(shouldAutocreateReflog(NOTE, cfg)).toBe(true);
    });

    it('Given true, When the ref is under refs/tags/, Then does not log', () => {
      // Arrange
      // Assert
      expect(shouldAutocreateReflog(TAG, cfg)).toBe(false);
    });

    it('Given true, When the ref is an unknown pseudo-ref, Then does not log', () => {
      // Arrange
      // Assert
      expect(shouldAutocreateReflog('FETCH_HEAD' as RefName, cfg)).toBe(false);
    });
  });
});

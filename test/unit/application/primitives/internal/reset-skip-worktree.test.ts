import { describe, expect, it } from 'vitest';

import { applyResetSkipWorktree } from '../../../../../src/application/primitives/internal/reset-skip-worktree.js';
import type { GitIndex, IndexEntry } from '../../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const OLD = 'a'.repeat(40) as ObjectId;
const NEW = 'b'.repeat(40) as ObjectId;
const EXPECTED_MTIME = 123;

const entry = (
  path: string,
  id: ObjectId,
  flags: Partial<IndexEntry['flags']> = {},
  mtimeSeconds = 0,
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, ...flags },
  path: path as FilePath,
});

const indexOf = (...entries: IndexEntry[]): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

const inPatternOnlyB = (p: FilePath): boolean => p.startsWith('b/');

describe('applyResetSkipWorktree', () => {
  const sut = applyResetSkipWorktree;

  describe('Given a changed entry whose donor carries the read bit', () => {
    describe('When the post-pass runs', () => {
      it('Then the rebuilt entry keeps the bit with a zero stat', () => {
        // Arrange
        const donor = entry('b/f', OLD, { skipWorktree: true }, EXPECTED_MTIME);
        const rebuilt = [entry('b/f', NEW)];

        // Act
        const result = sut(rebuilt, indexOf(donor), inPatternOnlyB);

        // Assert
        expect(result).toEqual([entry('b/f', NEW, { skipWorktree: true })]);
      });
    });
  });

  describe('Given a changed entry whose donor has no read bit, out of the patterns', () => {
    describe('When the post-pass runs', () => {
      it('Then the rebuilt entry gets no bit', () => {
        // Arrange
        const rebuilt = [entry('a/f', NEW)];

        // Act
        const result = sut(rebuilt, indexOf(entry('a/f', OLD)), inPatternOnlyB);

        // Assert
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given an unchanged entry', () => {
    describe('When the post-pass runs', () => {
      it('Then the entry is returned as it came', () => {
        // Arrange
        const kept = entry('a/f', OLD, {}, EXPECTED_MTIME);

        // Act
        const result = sut([kept], indexOf(kept), inPatternOnlyB);

        // Assert
        expect(result[0]).toBe(kept);
      });
    });
  });

  describe('Given a new out-of-pattern path', () => {
    describe('When the post-pass runs', () => {
      it('Then it gets the bit with a zero stat', () => {
        // Arrange
        const rebuilt = [entry('a/new', NEW)];

        // Act
        const result = sut(rebuilt, indexOf(), inPatternOnlyB);

        // Assert
        expect(result).toEqual([entry('a/new', NEW, { skipWorktree: true })]);
      });
    });
  });

  describe('Given a new in-pattern path', () => {
    describe('When the post-pass runs', () => {
      it('Then it gets no bit', () => {
        // Arrange
        const rebuilt = [entry('b/n', NEW)];

        // Act
        const result = sut(rebuilt, indexOf(), inPatternOnlyB);

        // Assert
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a new path and sparse inactive', () => {
    describe('When the post-pass runs', () => {
      it('Then it gets no bit', () => {
        // Arrange
        const rebuilt = [entry('a/new', NEW)];

        // Act
        const result = sut(rebuilt, indexOf(), undefined);

        // Assert
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a path present only as a stage-2 entry', () => {
    describe('When the post-pass runs', () => {
      it('Then it follows the patterns, not the conflicted entry', () => {
        // Arrange
        const conflicted = entry('b/f', OLD, { stage: 2, skipWorktree: true });
        const rebuilt = [entry('b/f', NEW)];

        // Act
        const result = sut(rebuilt, indexOf(conflicted), inPatternOnlyB);

        // Assert
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });
});

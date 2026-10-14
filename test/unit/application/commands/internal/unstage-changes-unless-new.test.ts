import { describe, expect, it } from 'vitest';
import { unstageChangesUnlessNew } from '../../../../../src/application/commands/internal/unstage-changes-unless-new.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const STATTED = 7;

const entry = (path: string, id: string, stage: 0 | 1 | 2 | 3 = 0): IndexEntry => ({
  ctimeSeconds: STATTED,
  ctimeNanoseconds: STATTED,
  mtimeSeconds: STATTED,
  mtimeNanoseconds: STATTED,
  dev: STATTED,
  ino: STATTED,
  mode: FILE_MODE.REGULAR,
  uid: STATTED,
  gid: STATTED,
  fileSize: STATTED,
  id: id as ObjectId,
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
});

const paths = (entries: ReadonlyArray<IndexEntry>): string[] => entries.map((e) => e.path);

describe('unstageChangesUnlessNew', () => {
  describe('Given a directory replaced by a file in the merged index', () => {
    describe('When the deleted directory entry is restored', () => {
      it('Then it is dropped because the new file now occupies its directory', () => {
        // Arrange
        const before = [entry('m', 'b'), entry('sub/y', 'a')];
        const merged = [entry('m', 'b'), entry('sub', 'c')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(paths(result.entries)).toEqual(['m', 'sub']);
      });
    });
  });

  describe('Given a file replaced by a directory in the merged index', () => {
    describe('When the deleted file entry is restored', () => {
      it('Then it is dropped because a new path lives under it', () => {
        // Arrange
        const before = [entry('d', 'a')];
        const merged = [entry('d/x', 'c')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(paths(result.entries)).toEqual(['d/x']);
      });
    });
  });

  describe('Given a changed, a deleted and an unchanged path', () => {
    describe('When the changes are unstaged', () => {
      it('Then changed and deleted paths return with zero stat and the unchanged one keeps its stat', () => {
        // Arrange
        const before = [entry('c', '1'), entry('d', '2'), entry('u', '3')];
        const merged = [entry('c', '9'), entry('u', '3')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => [e.path, e.id, e.fileSize])).toEqual([
          ['c', '1', 0],
          ['d', '2', 0],
          ['u', '3', STATTED],
        ]);
      });

      it('Then the restaged paths are the changed and deleted ones, not the unchanged one', () => {
        // Arrange
        const before = [entry('c', '1'), entry('d', '2'), entry('u', '3')];
        const merged = [entry('c', '9'), entry('u', '3')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.restagedPaths).toEqual(['c', 'd']);
      });
    });
  });

  describe('Given a path new to the merged index', () => {
    describe('When the changes are unstaged', () => {
      it('Then the new path stays staged and is reported as restaged', () => {
        // Arrange
        const before = [entry('u', '3')];
        const merged = [entry('n', '4'), entry('u', '3')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.restagedPaths).toEqual(['n']);
      });
    });
  });

  describe('Given a mode change with the same id', () => {
    describe('When the changes are unstaged', () => {
      it('Then the path is restored to its previous mode', () => {
        // Arrange
        const before = [entry('x', '1')];
        const merged = [{ ...entry('x', '1'), mode: FILE_MODE.EXECUTABLE }];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => [e.mode, e.fileSize])).toEqual([[FILE_MODE.REGULAR, 0]]);
      });
    });
  });

  describe('Given a changed path whose previous entry was assume-valid and skip-worktree', () => {
    describe('When the changes are unstaged', () => {
      it('Then the restored entry carries the plain stage-0 flags', () => {
        // Arrange
        const flagged = { ...STAGE0_FLAGS, assumeValid: true, skipWorktree: true };
        const before = [{ ...entry('x', '1'), flags: flagged }];
        const merged = [entry('x', '9')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => e.flags)).toEqual([STAGE0_FLAGS]);
      });
    });
  });

  describe('Given a new path sorting after, and a deleted path sorting after, the surviving ones', () => {
    describe('When the changes are unstaged', () => {
      it('Then every entry comes back once, in path order, with the new path reported first', () => {
        // Arrange
        const before = [entry('a', '1'), entry('b', '2'), entry('z', '3')];
        const merged = [entry('a', '1'), entry('y', '4')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(paths(result.entries)).toEqual(['a', 'b', 'y', 'z']);
        expect(result.restagedPaths).toEqual(['y', 'b', 'z']);
      });
    });
  });

  describe('Given a before index holding conflict stages for a path', () => {
    describe('When the changes are unstaged', () => {
      it('Then no entry is restored for the conflicted path', () => {
        // Arrange
        const before = [entry('c', '1', 1), entry('c', '2', 2), entry('c', '3', 3)];
        const merged: IndexEntry[] = [];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result).toEqual({ entries: [], restagedPaths: [] });
      });
    });
  });
});

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

const lossy = (path: string, bytes: number[], id: string): IndexEntry => ({
  ...entry(path, id),
  pathBytes: Uint8Array.from(bytes),
});

const paths = (entries: ReadonlyArray<IndexEntry>): string[] => entries.map((e) => e.path);

describe('unstageChangesUnlessNew', () => {
  describe('Given a before index an older writer left in UTF-16 order', () => {
    describe('When the merged index holds the same entries in byte order', () => {
      it('Then nothing is restored and nothing is reported as new', () => {
        // Arrange
        const before = [entry('\u{1F600}.txt', 'a'), entry('\uFFFD.txt', 'b')];
        const merged = [entry('\uFFFD.txt', 'b'), entry('\u{1F600}.txt', 'a')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries).toEqual(merged);
        expect(result.restagedPaths).toEqual([]);
      });
    });
  });

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
        expect(result.restagedPaths.map(({ path }) => path)).toEqual(['c', 'd']);
      });
    });
  });

  describe('Given a path new to the merged index', () => {
    describe('When the changes are unstaged', () => {
      it('Then the new path stays staged and is not reported as restaged', () => {
        // Arrange
        const before = [entry('u', '3')];
        const merged = [entry('n', '4'), entry('u', '3')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.restagedPaths).toEqual([]);
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
      it('Then every entry comes back once, in path order, and only the restored paths are reported', () => {
        // Arrange
        const before = [entry('a', '1'), entry('b', '2'), entry('z', '3')];
        const merged = [entry('a', '1'), entry('y', '4')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(paths(result.entries)).toEqual(['a', 'b', 'y', 'z']);
        expect(result.restagedPaths.map(({ path }) => path)).toEqual(['b', 'z']);
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

  describe('Given a lossy path new to the merged index and a deleted path with the same decoded view', () => {
    describe('When the changes are unstaged', () => {
      it('Then the deleted path is restored and the lossy path stays staged with its bytes', () => {
        // Arrange
        const before = [entry('\uFFFD.txt', 'u')];
        const merged = [lossy('\uFFFD.txt', [0xff, 0x2e, 0x74, 0x78, 0x74], 'l')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => [e.id, e.fileSize, e.pathBytes])).toEqual([
          ['u', 0, undefined],
          ['l', STATTED, Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74)],
        ]);
      });

      it('Then the restaged paths list the restored path only, not the lossy one kept staged', () => {
        // Arrange
        const before = [entry('\uFFFD.txt', 'u')];
        const merged = [lossy('\uFFFD.txt', [0xff, 0x2e, 0x74, 0x78, 0x74], 'l')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.restagedPaths).toEqual([{ path: '\uFFFD.txt' }]);
      });
    });
  });

  describe('Given a kept new lossy path inside a directory and a deleted file named like its decoded directory', () => {
    describe('When the changes are unstaged', () => {
      it('Then the deleted file is restored because the directory bytes differ', () => {
        // Arrange
        const before = [entry('\uFFFD', 'u')];
        const merged = [lossy('\uFFFD/x', [0xff, 0x2f, 0x78], 'l')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => e.id)).toEqual(['u', 'l']);
      });
    });
  });

  describe('Given a kept new lossy path in a lossy directory and deleted files around it', () => {
    describe('When the changes are unstaged', () => {
      it('Then the restored lossy file named like the directory is dropped and the U file kept', () => {
        // Arrange
        const before = [lossy('\uFFFD', [0xff], 'l'), entry('\uFFFD', 'u')];
        const merged = [lossy('\uFFFD/x', [0xff, 0x2f, 0x78], 'n')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => e.id)).toEqual(['u', 'n']);
      });
    });
  });

  describe('Given a kept new lossy file inside a valid directory and a deleted file named like it', () => {
    describe('When the changes are unstaged', () => {
      it('Then the deleted file is dropped', () => {
        // Arrange
        const before = [entry('d', 'u')];
        const merged = [lossy('d/\uFFFD', [0x64, 0x2f, 0xff], 'n')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => e.id)).toEqual(['n']);
      });
    });
  });

  describe('Given a kept new lossy path inside a valid directory and a deleted file named like it', () => {
    describe('When the changes are unstaged', () => {
      it('Then the deleted file is dropped because the directory bytes match', () => {
        // Arrange
        const before = [entry('d', 'u')];
        const merged = [lossy('d/\uFFFD', [0x64, 0x2f, 0xff], 'l')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => e.id)).toEqual(['l']);
      });
    });
  });

  describe('Given a restored lossy file and a kept new path below its raw name', () => {
    describe('When the changes are unstaged', () => {
      it('Then the restored lossy file is dropped by the directory it names', () => {
        // Arrange
        const before = [lossy('\uFFFD', [0xff], 'u')];
        const merged = [lossy('\uFFFD/x', [0xff, 0x2f, 0x78], 'l')];

        // Act
        const sut = unstageChangesUnlessNew;
        const result = sut(merged, before);

        // Assert
        expect(result.entries.map((e) => e.id)).toEqual(['l']);
      });
    });
  });
});

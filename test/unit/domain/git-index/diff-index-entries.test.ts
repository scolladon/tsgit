import { describe, expect, it } from 'vitest';
import { diffIndexEntries } from '../../../../src/domain/git-index/diff-index-entries.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const oid = (c: string): ObjectId => c.repeat(40) as ObjectId;

const entry = (
  path: string,
  options: { id?: string; mode?: FileMode; stage?: 0 | 1 | 2 | 3; fileSize?: number } = {},
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: options.mode ?? FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: options.fileSize ?? 0,
  id: oid(options.id ?? 'a'),
  flags: { ...STAGE0_FLAGS, stage: options.stage ?? 0 },
  path: path as FilePath,
});

describe('diffIndexEntries', () => {
  describe('Given an entry whose id changed', () => {
    describe('When diffing', () => {
      it('Then only that path is changed and the tracked set is stable', () => {
        // Arrange
        const before = [entry('a'), entry('d/c')];
        const after = [entry('a'), entry('d/c', { id: 'b' })];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['d/c']);
        expect(result.trackedSetChanged).toBe(false);
        expect(result.resolvedUnmerged).toBe(false);
      });
    });
  });

  describe('Given an entry whose mode changed', () => {
    describe('When diffing', () => {
      it('Then the path is changed', () => {
        // Arrange
        const before = [entry('a')];
        const after = [entry('a', { mode: FILE_MODE.EXECUTABLE })];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['a']);
        expect(result.trackedSetChanged).toBe(false);
      });
    });
  });

  describe('Given after adds d/e/n and drops a', () => {
    describe('When diffing', () => {
      it('Then both paths are changed in order and the tracked set changed', () => {
        // Arrange
        const before = [entry('a'), entry('d/c')];
        const after = [entry('d/c'), entry('d/e/n')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['a', 'd/e/n']);
        expect(result.trackedSetChanged).toBe(true);
      });
    });
  });

  describe('Given only the tail of one list differs in path set', () => {
    describe('When diffing', () => {
      it('Then the tracked set changed', () => {
        // Arrange
        const before = [entry('a')];
        const after = [entry('a'), entry('b')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.trackedSetChanged).toBe(true);
        expect(result.changedPaths).toEqual(['b']);
      });
    });
  });

  describe('Given stages 1,2,3 before and stage 0 after for m', () => {
    describe('When diffing', () => {
      it('Then the unmerged path is resolved and changed once', () => {
        // Arrange
        const before = [
          entry('m', { stage: 1, id: '1' }),
          entry('m', { stage: 2, id: '2' }),
          entry('m', { stage: 3, id: '3' }),
        ];
        const after = [entry('m', { id: '4' })];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.resolvedUnmerged).toBe(true);
        expect(result.changedPaths).toEqual(['m']);
        expect(result.trackedSetChanged).toBe(false);
      });
    });
  });

  describe('Given an unmerged path that stays unmerged', () => {
    describe('When diffing', () => {
      it('Then it is not reported resolved', () => {
        // Arrange
        const before = [entry('m', { stage: 1 }), entry('m', { stage: 2 })];
        const after = [entry('m', { stage: 2 }), entry('m', { stage: 3 })];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.resolvedUnmerged).toBe(false);
      });
    });
  });

  describe('Given an unmerged path that is removed', () => {
    describe('When diffing', () => {
      it('Then it is not reported resolved', () => {
        // Arrange
        const before = [entry('m', { stage: 1 })];
        const after = [entry('z')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.resolvedUnmerged).toBe(false);
        expect(result.trackedSetChanged).toBe(true);
      });
    });
  });

  describe('Given an unmerged path resolved after earlier unrelated paths', () => {
    describe('When diffing', () => {
      it('Then the resolution is still found', () => {
        // Arrange
        const before = [entry('a'), entry('m', { stage: 2 })];
        const after = [entry('a'), entry('b'), entry('m')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.resolvedUnmerged).toBe(true);
      });
    });
  });

  describe('Given unsorted UTF-16-ordered inputs with only a stat change', () => {
    describe('When diffing', () => {
      it('Then nothing changed', () => {
        // Arrange
        const before = [entry('\u{1F600}.txt'), entry('�.txt')];
        const after = [entry('�.txt', { fileSize: 9 }), entry('\u{1F600}.txt', { fileSize: 9 })];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result).toEqual({
          changedPaths: [],
          trackedSetChanged: false,
          resolvedUnmerged: false,
        });
      });
    });
  });

  describe('Given only the after list holds a supplementary-plane path, in unsorted input order', () => {
    describe('When diffing', () => {
      it('Then only the added path is changed and the tracked set changed', () => {
        // Arrange
        const before = [entry('\uFF5E.txt'), entry('a')];
        const after = [entry('\u{1F600}.txt'), entry('\uFF5E.txt'), entry('a')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['\u{1F600}.txt']);
        expect(result.trackedSetChanged).toBe(true);
      });
    });
  });

  describe('Given unsorted ASCII inputs', () => {
    describe('When diffing', () => {
      it('Then the caller lists are left untouched and the change is found', () => {
        // Arrange
        const before = [entry('b'), entry('a')];
        const after = [entry('b', { id: 'c' }), entry('a')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['b']);
        expect(before.map((e) => e.path)).toEqual(['b', 'a']);
      });
    });
  });

  describe('Given a sparse-checkout flag flip', () => {
    describe('When diffing', () => {
      it('Then nothing changed', () => {
        // Arrange
        const before = [entry('a')];
        const flagged = { ...entry('a'), flags: { ...STAGE0_FLAGS, skipWorktree: true } };

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, [flagged]);

        // Assert
        expect(result.changedPaths).toEqual([]);
      });
    });
  });
});

describe('diffIndexEntries stage and path ordering', () => {
  describe('Given the same unmerged path listed in descending stage order before and ascending after', () => {
    describe('When diffing', () => {
      it('Then each stage is paired with its twin and nothing is changed', () => {
        // Arrange
        const before = [
          entry('m', { stage: 3, id: '3' }),
          entry('m', { stage: 2, id: '2' }),
          entry('m', { stage: 1, id: '1' }),
        ];
        const after = [
          entry('m', { stage: 1, id: '1' }),
          entry('m', { stage: 2, id: '2' }),
          entry('m', { stage: 3, id: '3' }),
        ];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual([]);
      });
    });
  });

  describe('Given a before list with code units at or above U+D800 and a plain after list', () => {
    describe('When diffing', () => {
      it('Then changed paths follow UTF-8 byte order', () => {
        // Arrange
        const before = [entry('￿'), entry('\u{1F600}')];
        const after = [entry('a')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['a', '￿', '\u{1F600}']);
      });
    });
  });

  describe('Given a plain before list and an after list with code units at or above U+D800', () => {
    describe('When diffing', () => {
      it('Then changed paths follow UTF-8 byte order', () => {
        // Arrange
        const before = [entry('a')];
        const after = [entry('￿'), entry('\u{1F600}')];

        // Act
        const sut = diffIndexEntries;
        const result = sut(before, after);

        // Assert
        expect(result.changedPaths).toEqual(['a', '￿', '\u{1F600}']);
      });
    });
  });
});

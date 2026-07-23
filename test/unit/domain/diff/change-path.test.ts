import { describe, expect, it } from 'vitest';
import { primaryPath } from '../../../../src/domain/diff/change-path.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const MODE: FileMode = FILE_MODE.REGULAR;

describe('primaryPath — per-variant sort key', () => {
  describe('Given a change of any discriminated-union variant', () => {
    describe('When primaryPath called', () => {
      it.each([
        {
          variant: 'AddChange',
          change: {
            type: 'add' as const,
            newPath: 'added' as FilePath,
            newId: ID_A,
            newMode: MODE,
          },
          expected: 'added',
        },
        {
          variant: 'DeleteChange',
          change: {
            type: 'delete' as const,
            oldPath: 'gone' as FilePath,
            oldId: ID_A,
            oldMode: MODE,
          },
          expected: 'gone',
        },
        {
          variant: 'RenameChange',
          change: {
            type: 'rename' as const,
            oldPath: 'src' as FilePath,
            newPath: 'dest' as FilePath,
            oldId: ID_A,
            newId: ID_A,
            oldMode: MODE,
            newMode: MODE,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          expected: 'dest',
        },
        {
          variant: 'ModifyChange',
          change: {
            type: 'modify' as const,
            path: 'changed' as FilePath,
            oldId: ID_A,
            newId: ID_B,
            oldMode: MODE,
            newMode: MODE,
          },
          expected: 'changed',
        },
        {
          variant: 'TypeChangeChange',
          change: {
            type: 'type-change' as const,
            path: 'retyped' as FilePath,
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
          expected: 'retyped',
        },
        {
          variant: 'CopyChange',
          change: {
            type: 'copy' as const,
            oldPath: 'src' as FilePath,
            newPath: 'dst' as FilePath,
            oldId: ID_A,
            newId: ID_B,
            oldMode: MODE,
            newMode: MODE,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          expected: 'dst',
        },
      ])('Then $variant returns $expected', ({ change, expected }) => {
        // Act
        const sut = primaryPath(change);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

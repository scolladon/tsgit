import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isGitlink, isSameKind, kindOf } from '../../../../src/domain/diff/mode-kind.js';
import type { FileMode } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

describe('kindOf', () => {
  describe('Given a file mode', () => {
    describe('When kindOf called', () => {
      it.each([
        [FILE_MODE.REGULAR, 'file'],
        [FILE_MODE.EXECUTABLE, 'file'],
        [FILE_MODE.SYMLINK, 'symlink'],
        [FILE_MODE.DIRECTORY, 'directory'],
        [FILE_MODE.GITLINK, 'gitlink'],
      ])('Then mode %s returns kind %s', (mode, expected) => {
        // Arrange + Act
        const sut = kindOf(mode);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('isSameKind', () => {
  describe('Given a pair of file modes', () => {
    describe('When isSameKind called', () => {
      it.each([
        [FILE_MODE.REGULAR, FILE_MODE.EXECUTABLE, true],
        [FILE_MODE.REGULAR, FILE_MODE.SYMLINK, false],
        [FILE_MODE.DIRECTORY, FILE_MODE.DIRECTORY, true],
        [FILE_MODE.DIRECTORY, FILE_MODE.REGULAR, false],
        [FILE_MODE.GITLINK, FILE_MODE.GITLINK, true],
        [FILE_MODE.GITLINK, FILE_MODE.DIRECTORY, false],
      ])('Then isSameKind(%s, %s) is %s', (a, b, expected) => {
        // Arrange + Act
        const sut = isSameKind(a, b);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given the property "isSameKind(a, b) === isSameKind(b, a) (symmetry)"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange
        const allModes: FileMode[] = [
          FILE_MODE.REGULAR,
          FILE_MODE.EXECUTABLE,
          FILE_MODE.SYMLINK,
          FILE_MODE.DIRECTORY,
          FILE_MODE.GITLINK,
        ];
        const modeArb = fc.constantFrom(...allModes);
        // Assert
        fc.assert(
          fc.property(modeArb, modeArb, (a, b) => {
            return isSameKind(a, b) === isSameKind(b, a);
          }),
        );
      });
    });
  });
});

describe('isGitlink', () => {
  describe('Given FILE_MODE.GITLINK', () => {
    describe('When isGitlink called', () => {
      it('Then returns true', () => {
        // Arrange
        const mode = FILE_MODE.GITLINK;

        // Act
        const sut = isGitlink(mode);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a non-gitlink mode', () => {
    describe('When isGitlink called', () => {
      it('Then returns false for REGULAR, EXECUTABLE, SYMLINK, and DIRECTORY', () => {
        // Arrange
        const nonGitlinkModes: FileMode[] = [
          FILE_MODE.REGULAR,
          FILE_MODE.EXECUTABLE,
          FILE_MODE.SYMLINK,
          FILE_MODE.DIRECTORY,
        ];

        for (const mode of nonGitlinkModes) {
          // Act
          const sut = isGitlink(mode);

          // Assert
          expect(sut).toBe(false);
        }
      });
    });
  });
});

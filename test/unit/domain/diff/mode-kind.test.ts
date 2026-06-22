import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isGitlink, isSameKind, kindOf } from '../../../../src/domain/diff/mode-kind.js';
import type { FileMode } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

describe('kindOf', () => {
  describe('Given FILE_MODE.REGULAR', () => {
    describe('When kindOf called', () => {
      it('Then returns file', () => {
        // Arrange
        const mode = FILE_MODE.REGULAR;

        // Act
        const sut = kindOf(mode);

        // Assert
        expect(sut).toBe('file');
      });
    });
  });

  describe('Given FILE_MODE.EXECUTABLE', () => {
    describe('When kindOf called', () => {
      it('Then returns file', () => {
        // Arrange
        const mode = FILE_MODE.EXECUTABLE;

        // Act
        const sut = kindOf(mode);

        // Assert
        expect(sut).toBe('file');
      });
    });
  });

  describe('Given FILE_MODE.SYMLINK', () => {
    describe('When kindOf called', () => {
      it('Then returns symlink', () => {
        // Arrange
        const mode = FILE_MODE.SYMLINK;

        // Act
        const sut = kindOf(mode);

        // Assert
        expect(sut).toBe('symlink');
      });
    });
  });

  describe('Given FILE_MODE.DIRECTORY', () => {
    describe('When kindOf called', () => {
      it('Then returns directory', () => {
        // Arrange
        const mode = FILE_MODE.DIRECTORY;

        // Act
        const sut = kindOf(mode);

        // Assert
        expect(sut).toBe('directory');
      });
    });
  });

  describe('Given FILE_MODE.GITLINK', () => {
    describe('When kindOf called', () => {
      it('Then returns gitlink', () => {
        // Arrange
        const mode = FILE_MODE.GITLINK;

        // Act
        const sut = kindOf(mode);

        // Assert
        expect(sut).toBe('gitlink');
      });
    });
  });
});

describe('isSameKind', () => {
  describe('Given REGULAR and EXECUTABLE', () => {
    describe('When isSameKind called', () => {
      it('Then returns true (both file)', () => {
        // Arrange & Act
        const sut = isSameKind(FILE_MODE.REGULAR, FILE_MODE.EXECUTABLE);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given REGULAR and SYMLINK', () => {
    describe('When isSameKind called', () => {
      it('Then returns false (file vs symlink)', () => {
        // Arrange & Act
        const sut = isSameKind(FILE_MODE.REGULAR, FILE_MODE.SYMLINK);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given DIRECTORY and DIRECTORY', () => {
    describe('When isSameKind called', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const sut = isSameKind(FILE_MODE.DIRECTORY, FILE_MODE.DIRECTORY);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given DIRECTORY and REGULAR', () => {
    describe('When isSameKind called', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const sut = isSameKind(FILE_MODE.DIRECTORY, FILE_MODE.REGULAR);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given GITLINK and GITLINK', () => {
    describe('When isSameKind called', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const sut = isSameKind(FILE_MODE.GITLINK, FILE_MODE.GITLINK);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given GITLINK and DIRECTORY', () => {
    describe('When isSameKind called', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const sut = isSameKind(FILE_MODE.GITLINK, FILE_MODE.DIRECTORY);

        // Assert
        expect(sut).toBe(false);
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

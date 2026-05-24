import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isSameKind, kindOf } from '../../../../src/domain/diff/mode-kind.js';
import type { FileMode } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

describe('kindOf', () => {
  it('Given FILE_MODE.REGULAR, When kindOf called, Then returns file', () => {
    // Arrange
    const mode = FILE_MODE.REGULAR;

    // Act
    const sut = kindOf(mode);

    // Assert
    expect(sut).toBe('file');
  });

  it('Given FILE_MODE.EXECUTABLE, When kindOf called, Then returns file', () => {
    // Arrange
    const mode = FILE_MODE.EXECUTABLE;

    // Act
    const sut = kindOf(mode);

    // Assert
    expect(sut).toBe('file');
  });

  it('Given FILE_MODE.SYMLINK, When kindOf called, Then returns symlink', () => {
    // Arrange
    const mode = FILE_MODE.SYMLINK;

    // Act
    const sut = kindOf(mode);

    // Assert
    expect(sut).toBe('symlink');
  });

  it('Given FILE_MODE.DIRECTORY, When kindOf called, Then returns directory', () => {
    // Arrange
    const mode = FILE_MODE.DIRECTORY;

    // Act
    const sut = kindOf(mode);

    // Assert
    expect(sut).toBe('directory');
  });

  it('Given FILE_MODE.GITLINK, When kindOf called, Then returns gitlink', () => {
    // Arrange
    const mode = FILE_MODE.GITLINK;

    // Act
    const sut = kindOf(mode);

    // Assert
    expect(sut).toBe('gitlink');
  });
});

describe('isSameKind', () => {
  it('Given REGULAR and EXECUTABLE, When isSameKind called, Then returns true (both file)', () => {
    // Arrange & Act
    const sut = isSameKind(FILE_MODE.REGULAR, FILE_MODE.EXECUTABLE);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given REGULAR and SYMLINK, When isSameKind called, Then returns false (file vs symlink)', () => {
    // Arrange & Act
    const sut = isSameKind(FILE_MODE.REGULAR, FILE_MODE.SYMLINK);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given DIRECTORY and DIRECTORY, When isSameKind called, Then returns true', () => {
    // Arrange & Act
    const sut = isSameKind(FILE_MODE.DIRECTORY, FILE_MODE.DIRECTORY);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given DIRECTORY and REGULAR, When isSameKind called, Then returns false', () => {
    // Arrange & Act
    const sut = isSameKind(FILE_MODE.DIRECTORY, FILE_MODE.REGULAR);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given GITLINK and GITLINK, When isSameKind called, Then returns true', () => {
    // Arrange & Act
    const sut = isSameKind(FILE_MODE.GITLINK, FILE_MODE.GITLINK);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given GITLINK and DIRECTORY, When isSameKind called, Then returns false', () => {
    // Arrange & Act
    const sut = isSameKind(FILE_MODE.GITLINK, FILE_MODE.DIRECTORY);

    // Assert
    expect(sut).toBe(false);
  });

  it('Property: isSameKind(a, b) === isSameKind(b, a) (symmetry)', () => {
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

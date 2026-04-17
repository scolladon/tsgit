import { describe, expect, it } from 'vitest';
import { primaryPath } from '../../../../src/domain/diff/change-path.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const MODE: FileMode = FILE_MODE.REGULAR;

describe('primaryPath — per-variant sort key', () => {
  it('Given AddChange, When primaryPath called, Then returns newPath', () => {
    // Arrange
    const change = {
      type: 'add' as const,
      newPath: 'added' as FilePath,
      newId: ID_A,
      newMode: MODE,
    };

    // Act
    const sut = primaryPath(change);

    // Assert
    expect(sut).toBe('added');
  });

  it('Given DeleteChange, When primaryPath called, Then returns oldPath', () => {
    // Arrange
    const change = {
      type: 'delete' as const,
      oldPath: 'gone' as FilePath,
      oldId: ID_A,
      oldMode: MODE,
    };

    // Act
    const sut = primaryPath(change);

    // Assert
    expect(sut).toBe('gone');
  });

  it('Given RenameChange, When primaryPath called, Then returns newPath', () => {
    // Arrange
    const change = {
      type: 'rename' as const,
      oldPath: 'src' as FilePath,
      newPath: 'dest' as FilePath,
      id: ID_A,
      mode: MODE,
    };

    // Act
    const sut = primaryPath(change);

    // Assert
    expect(sut).toBe('dest');
  });

  it('Given ModifyChange, When primaryPath called, Then returns path', () => {
    // Arrange
    const change = {
      type: 'modify' as const,
      path: 'changed' as FilePath,
      oldId: ID_A,
      newId: ID_B,
      oldMode: MODE,
      newMode: MODE,
    };

    // Act
    const sut = primaryPath(change);

    // Assert
    expect(sut).toBe('changed');
  });

  it('Given TypeChangeChange, When primaryPath called, Then returns path', () => {
    // Arrange
    const change = {
      type: 'type-change' as const,
      path: 'retyped' as FilePath,
      oldId: ID_A,
      newId: ID_B,
      oldMode: FILE_MODE.REGULAR,
      newMode: FILE_MODE.SYMLINK,
    };

    // Act
    const sut = primaryPath(change);

    // Assert
    expect(sut).toBe('retyped');
  });
});

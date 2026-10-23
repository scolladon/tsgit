import { describe, expect, it } from 'vitest';
import type { IgnorePredicate } from '../../../../../src/application/commands/internal/add-ignore.js';
import { pruneGitlinkDirectories } from '../../../../../src/application/commands/internal/prune-gitlink-directories.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE, type FileMode } from '../../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

const entry = (path: string, mode: FileMode, stage: 0 | 1 = 0): IndexEntry =>
  ({ path, mode, flags: { ...STAGE0_FLAGS, stage } }) as unknown as IndexEntry;

const keepEverything: IgnorePredicate = () => false;
const dropEverything: IgnorePredicate = () => true;

describe('pruneGitlinkDirectories', () => {
  describe('Given a stage-0 gitlink entry', () => {
    describe('When the walk asks about its directory', () => {
      it('Then the directory is pruned without consulting the wrapped predicate', async () => {
        // Arrange
        const consulted: string[] = [];
        const sut = pruneGitlinkDirectories;
        const ignore = sut(
          (path) => {
            consulted.push(path);
            return false;
          },
          [entry('sub', FILE_MODE.GITLINK)],
        );

        // Act
        const verdict = await ignore('sub' as FilePath, true);

        // Assert
        expect(verdict).toBe(true);
        expect(consulted).toEqual([]);
      });
    });

    describe('When the walk asks about a leaf of the same name', () => {
      it('Then the wrapped predicate decides', async () => {
        // Arrange
        const sut = pruneGitlinkDirectories;
        const ignore = sut(keepEverything, [entry('sub', FILE_MODE.GITLINK)]);

        // Act
        const verdict = await ignore('sub' as FilePath, false);

        // Assert
        expect(verdict).toBe(false);
      });
    });

    describe('When the walk asks about another directory', () => {
      it('Then the wrapped predicate decides', async () => {
        // Arrange
        const sut = pruneGitlinkDirectories;
        const ignore = sut(keepEverything, [entry('sub', FILE_MODE.GITLINK)]);

        // Act
        const verdict = await ignore('other' as FilePath, true);

        // Assert
        expect(verdict).toBe(false);
      });
    });
  });

  describe('Given a gitlink entry that is not at stage 0', () => {
    describe('When the walk asks about its directory', () => {
      it('Then the wrapped predicate decides', async () => {
        // Arrange
        const sut = pruneGitlinkDirectories;
        const ignore = sut(keepEverything, [entry('sub', FILE_MODE.GITLINK, 1)]);

        // Act
        const verdict = await ignore('sub' as FilePath, true);

        // Assert
        expect(verdict).toBe(false);
      });
    });
  });

  describe('Given a regular file entry', () => {
    describe('When the walk asks about a directory of its name and the wrapped predicate ignores it', () => {
      it('Then the wrapped verdict is returned', async () => {
        // Arrange
        const sut = pruneGitlinkDirectories;
        const ignore = sut(dropEverything, [entry('sub', FILE_MODE.REGULAR)]);

        // Act
        const verdict = await ignore('sub' as FilePath, true);

        // Assert
        expect(verdict).toBe(true);
      });
    });
  });
});

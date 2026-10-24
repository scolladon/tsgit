import { describe, expect, it } from 'vitest';

import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import {
  gitmodulesNotStaged,
  gitmodulesUnmerged,
  submoduleGitDirNested,
  submoduleNameNotFound,
  submoduleObjectFormatMismatch,
  submodulePathIsSymlink,
} from '../../../../src/domain/submodule/error.js';

describe('submoduleObjectFormatMismatch', () => {
  describe('Given a superproject and a submodule source on different algorithms', () => {
    describe('When the helper is called', () => {
      it('Then the payload names each side, so a caller can tell which end to change', () => {
        // Arrange
        const sut = submoduleObjectFormatMismatch;

        // Act
        const result = sut('sha1', 'sha256');

        // Assert
        expect(result.data).toEqual({
          code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH',
          local: 'sha1',
          remote: 'sha256',
        });
      });
    });
  });

  describe('Given the mirrored direction', () => {
    describe('When the helper is called', () => {
      it('Then local and remote are not transposed', () => {
        // Arrange — the transposition is invisible to a single-direction test:
        // both fields are the same two-member enum, so only asserting the
        // mirror proves the arguments reach the fields they name.
        const sut = submoduleObjectFormatMismatch;

        // Act
        const result = sut('sha256', 'sha1');

        // Assert
        expect(result.data).toEqual({
          code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH',
          local: 'sha256',
          remote: 'sha1',
        });
      });
    });
  });
});

describe('submodulePathIsSymlink', () => {
  describe('Given a submodule path', () => {
    describe('When the helper is called', () => {
      it('Then a symlinked leading component rides along and the message names it', () => {
        // Arrange
        const sut = submodulePathIsSymlink;

        // Act
        const result = sut('a/sub' as FilePath, 'a' as FilePath);

        // Assert
        expect(result.data).toEqual({
          code: 'SUBMODULE_PATH_IS_SYMLINK',
          path: 'a/sub',
          component: 'a',
        });
        expect(result.message).toBe(
          "SUBMODULE_PATH_IS_SYMLINK: expected 'a' in submodule path 'a/sub' not to be a symbolic link",
        );
      });

      it('Then the payload carries the code and the path', () => {
        // Arrange
        const sut = submodulePathIsSymlink;

        // Act
        const result = sut('sub' as FilePath);

        // Assert
        expect(result.data).toEqual({ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' });
      });

      it("Then the message mirrors git's refusal", () => {
        // Arrange
        const sut = submodulePathIsSymlink;

        // Act
        const result = sut('sub' as FilePath).message;

        // Assert
        expect(result).toBe(
          "SUBMODULE_PATH_IS_SYMLINK: expected submodule path 'sub' not to be a symbolic link",
        );
      });
    });
  });
});

describe('gitmodulesNotStaged', () => {
  describe('Given no input', () => {
    describe('When the helper is called', () => {
      it('Then the payload carries the code and no other key', () => {
        // Arrange
        const sut = gitmodulesNotStaged;

        // Act
        const result = sut();

        // Assert
        expect(result.data).toStrictEqual({ code: 'GITMODULES_NOT_STAGED' });
      });

      it("Then the message mirrors git's refusal", () => {
        // Arrange
        const sut = gitmodulesNotStaged;

        // Act
        const result = sut().message;

        // Assert
        expect(result).toBe(
          'GITMODULES_NOT_STAGED: please stage your changes to .gitmodules or stash them to proceed',
        );
      });
    });
  });
});

describe('submoduleNameNotFound', () => {
  describe('Given an embedded repository whose path has no .gitmodules name', () => {
    describe('When the helper is called', () => {
      it('Then the payload carries the code and the path', () => {
        // Arrange
        const sut = submoduleNameNotFound;

        // Act
        const result = sut('sub' as FilePath);

        // Assert
        expect(result.data).toStrictEqual({ code: 'SUBMODULE_NAME_NOT_FOUND', path: 'sub' });
      });

      it("Then the message mirrors git's refusal", () => {
        // Arrange
        const sut = submoduleNameNotFound;

        // Act
        const result = sut('sub' as FilePath).message;

        // Assert
        expect(result).toBe("SUBMODULE_NAME_NOT_FOUND: could not lookup name for submodule 'sub'");
      });
    });
  });
});

describe('submoduleGitDirNested', () => {
  describe('Given a module name whose prefix already holds a repository', () => {
    describe('When the helper is called', () => {
      it('Then the payload carries the code, the name and the enclosing name', () => {
        // Arrange
        const sut = submoduleGitDirNested;

        // Act
        const result = sut('a/b', 'a');

        // Assert
        expect(result.data).toStrictEqual({
          code: 'SUBMODULE_GIT_DIR_NESTED',
          name: 'a/b',
          inside: 'a',
        });
      });

      it("Then the message mirrors git's refusal", () => {
        // Arrange
        const sut = submoduleGitDirNested;

        // Act
        const result = sut('a/b', 'a').message;

        // Assert
        expect(result).toBe(
          "SUBMODULE_GIT_DIR_NESTED: submodule git dir '.git/modules/a/b' is inside git dir '.git/modules/a'",
        );
      });
    });
  });
});

describe('gitmodulesUnmerged', () => {
  describe('Given an unmerged .gitmodules', () => {
    describe('When the helper is called', () => {
      it('Then the payload carries only the code', () => {
        // Arrange
        const sut = gitmodulesUnmerged;

        // Act
        const result = sut();

        // Assert
        expect(result.data).toStrictEqual({ code: 'GITMODULES_UNMERGED' });
      });

      it("Then the message mirrors git's refusal", () => {
        // Arrange
        const sut = gitmodulesUnmerged;

        // Act
        const result = sut().message;

        // Assert
        expect(result).toBe(
          'GITMODULES_UNMERGED: Cannot change unmerged .gitmodules, resolve merge conflicts first',
        );
      });
    });
  });
});

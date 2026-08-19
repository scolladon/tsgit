import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import {
  alreadyInitialized,
  bareRepository,
  notARepository,
  type RepositoryError,
  repositoryExtensionsUnsupported,
  repositoryExtensionUnsupported,
  repositoryFormatVersionUnsupported,
  workTreeConfigInvalid,
  workTreeRequired,
  workTreeUnresolvable,
} from '../../../../src/domain/repository/error.js';

describe('domain repository error', () => {
  describe('factory data', () => {
    describe('Given notARepository("/some/path")', () => {
      describe('When checking data', () => {
        it('Then code and path preserved', () => {
          // Arrange & Act
          const result = notARepository('/some/path' as FilePath);

          // Assert
          expect(result.data).toEqual({ code: 'NOT_A_REPOSITORY', path: '/some/path' });
        });
      });
    });

    describe('Given bareRepository("add")', () => {
      describe('When checking data', () => {
        it('Then code and operation preserved', () => {
          // Arrange & Act
          const result = bareRepository('add');

          // Assert
          expect(result.data).toEqual({ code: 'BARE_REPOSITORY', operation: 'add' });
        });
      });
    });

    describe('Given workTreeRequired("add")', () => {
      describe('When checking data', () => {
        it('Then code and operation preserved', () => {
          // Arrange & Act
          const result = workTreeRequired('add');

          // Assert
          expect(result.data).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'add' });
        });
      });
    });

    describe('Given workTreeConfigInvalid("/repo/.git")', () => {
      describe('When checking data', () => {
        it('Then code and gitDir preserved', () => {
          // Arrange & Act
          const result = workTreeConfigInvalid('/repo/.git');

          // Assert
          expect(result.data).toEqual({ code: 'WORK_TREE_CONFIG_INVALID', gitDir: '/repo/.git' });
        });
      });
    });

    describe('Given alreadyInitialized("/repo/.git")', () => {
      describe('When checking data', () => {
        it('Then code and path preserved', () => {
          // Arrange & Act
          const result = alreadyInitialized('/repo/.git' as FilePath);

          // Assert
          expect(result.data).toEqual({ code: 'ALREADY_INITIALIZED', path: '/repo/.git' });
        });
      });
    });

    describe('Given workTreeUnresolvable("../missing", "/repo/.git")', () => {
      describe('When checking data', () => {
        it('Then code, value and gitDir preserved', () => {
          // Arrange & Act
          const result = workTreeUnresolvable('../missing', '/repo/.git');

          // Assert
          expect(result.data).toEqual({
            code: 'WORK_TREE_UNRESOLVABLE',
            value: '../missing',
            gitDir: '/repo/.git',
          });
        });
      });
    });

    describe('Given repositoryFormatVersionUnsupported(99)', () => {
      describe('When checking data', () => {
        it('Then code and parsed version preserved', () => {
          // Arrange & Act
          const result = repositoryFormatVersionUnsupported(99);

          // Assert
          expect(result.data).toEqual({
            code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
            version: 99,
          });
        });
      });
    });

    describe('Given repositoryExtensionsUnsupported(1, ["bogus", "alsoBogus"])', () => {
      describe('When checking data', () => {
        it('Then code, version and extensions preserved', () => {
          // Arrange & Act
          const result = repositoryExtensionsUnsupported(1, ['bogus', 'alsoBogus']);

          // Assert
          expect(result.data).toEqual({
            code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
            version: 1,
            extensions: ['bogus', 'alsoBogus'],
          });
        });
      });
    });

    describe('Given repositoryExtensionsUnsupported(0, ["objectformat"])', () => {
      describe('When checking data', () => {
        it('Then code, version and extensions preserved', () => {
          // Arrange & Act
          const result = repositoryExtensionsUnsupported(0, ['objectformat']);

          // Assert
          expect(result.data).toEqual({
            code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
            version: 0,
            extensions: ['objectformat'],
          });
        });
      });
    });

    describe('Given repositoryExtensionUnsupported("compatobjectformat", "sha1")', () => {
      describe('When checking data', () => {
        it('Then code, extension and value preserved', () => {
          // Arrange & Act
          const result = repositoryExtensionUnsupported('compatobjectformat', 'sha1');

          // Assert
          expect(result.data).toEqual({
            code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
            extension: 'compatobjectformat',
            value: 'sha1',
          });
        });
      });
    });
  });

  describe('extractDetail message formatting (exact match)', () => {
    type Case = readonly [RepositoryError, string];

    const cases: ReadonlyArray<Case> = [
      [
        { code: 'NOT_A_REPOSITORY', path: '/foo/bar' as FilePath },
        'NOT_A_REPOSITORY: not a git repository: bar',
      ],
      [
        { code: 'BARE_REPOSITORY', operation: 'add' },
        'BARE_REPOSITORY: operation requires a working tree: add',
      ],
      [
        { code: 'WORK_TREE_REQUIRED', operation: 'status' },
        'WORK_TREE_REQUIRED: operation requires a working tree: status',
      ],
      [
        { code: 'WORK_TREE_CONFIG_INVALID', gitDir: '/repo/.git' },
        'WORK_TREE_CONFIG_INVALID: unable to set up work tree using invalid config: /repo/.git',
      ],
      [
        { code: 'ALREADY_INITIALIZED', path: '/foo/.git' as FilePath },
        'ALREADY_INITIALIZED: repository already exists: .git',
      ],
      [
        { code: 'WORK_TREE_UNRESOLVABLE', value: '../missing', gitDir: '/repo/.git' },
        "WORK_TREE_UNRESOLVABLE: cannot resolve work tree '../missing' from .git",
      ],
      [
        { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 99 },
        'REPOSITORY_FORMAT_VERSION_UNSUPPORTED: unsupported repository format version: 99',
      ],
      [
        {
          code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
          version: 1,
          extensions: ['bogus', 'alsoBogus'],
        },
        'REPOSITORY_EXTENSIONS_UNSUPPORTED: unsupported repository extensions at format version 1: 2 (first: bogus)',
      ],
      [
        {
          code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
          extension: 'compatobjectformat',
          value: 'sha1',
        },
        'REPOSITORY_EXTENSION_UNSUPPORTED: repository extension not supported: compatobjectformat = sha1',
      ],
    ];

    describe('Given repository error %j', () => {
      describe('When TsgitError(...).message is read', () => {
        it.each(cases)('Then it equals the documented format', (data, expected) => {
          // Arrange & Act
          const result = new TsgitError(data);

          // Assert
          expect(result.message).toBe(expected);
        });
      });
    });
  });
});

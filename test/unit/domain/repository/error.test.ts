import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import {
  alreadyInitialized,
  bareRepository,
  notARepository,
  type RepositoryError,
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

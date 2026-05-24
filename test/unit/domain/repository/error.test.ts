import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import {
  alreadyInitialized,
  bareRepository,
  notARepository,
  type RepositoryError,
} from '../../../../src/domain/repository/error.js';

describe('domain repository error', () => {
  describe('factory data', () => {
    describe('Given notARepository("/some/path")', () => {
      describe('When checking data', () => {
        it('Then code and path preserved', () => {
          // Arrange & Act
          const sut = notARepository('/some/path' as FilePath);

          // Assert
          expect(sut.data).toEqual({ code: 'NOT_A_REPOSITORY', path: '/some/path' });
        });
      });
    });

    describe('Given bareRepository("add")', () => {
      describe('When checking data', () => {
        it('Then code and operation preserved', () => {
          // Arrange & Act
          const sut = bareRepository('add');

          // Assert
          expect(sut.data).toEqual({ code: 'BARE_REPOSITORY', operation: 'add' });
        });
      });
    });

    describe('Given alreadyInitialized("/repo/.git")', () => {
      describe('When checking data', () => {
        it('Then code and path preserved', () => {
          // Arrange & Act
          const sut = alreadyInitialized('/repo/.git' as FilePath);

          // Assert
          expect(sut.data).toEqual({ code: 'ALREADY_INITIALIZED', path: '/repo/.git' });
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
        { code: 'ALREADY_INITIALIZED', path: '/foo/.git' as FilePath },
        'ALREADY_INITIALIZED: repository already exists: .git',
      ],
    ];

    describe('Given repository error %j', () => {
      describe('When TsgitError(...).message is read', () => {
        it.each(cases)('Then it equals the documented format', (data, expected) => {
          // Arrange & Act
          const sut = new TsgitError(data);

          // Assert
          expect(sut.message).toBe(expected);
        });
      });
    });
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isUnsafeWorktreeId, worktreeAdminId } from '../../../../src/domain/worktree/admin-id.js';

describe('worktreeAdminId', () => {
  describe('Given a basename not yet taken', () => {
    describe('When worktreeAdminId runs', () => {
      it('Then returns the basename unchanged', () => {
        // Arrange
        const sut = new Set<string>();

        // Act
        const result = worktreeAdminId('shared', sut);

        // Assert
        expect(result).toBe('shared');
      });
    });
  });

  describe('Given the basename is taken', () => {
    describe('When worktreeAdminId runs', () => {
      it('Then appends the first free integer', () => {
        // Arrange
        const sut = new Set(['shared']);

        // Act
        const result = worktreeAdminId('shared', sut);

        // Assert
        expect(result).toBe('shared1');
      });
    });
  });

  describe('Given the basename and its first suffix are taken', () => {
    describe('When worktreeAdminId runs', () => {
      it('Then appends the next free integer', () => {
        // Arrange
        const sut = new Set(['shared', 'shared1']);

        // Act
        const result = worktreeAdminId('shared', sut);

        // Assert
        expect(result).toBe('shared2');
      });
    });
  });

  describe('Given a suffix is taken but the basename itself is free', () => {
    describe('When worktreeAdminId runs', () => {
      it('Then prefers the bare basename', () => {
        // Arrange
        const sut = new Set(['shared1']);

        // Act
        const result = worktreeAdminId('shared', sut);

        // Assert
        expect(result).toBe('shared');
      });
    });
  });

  describe('Given an arbitrary basename and taken set', () => {
    describe('When worktreeAdminId runs', () => {
      it('Then the result is never already taken', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 20 }),
            (basename, takenList) => {
              const sut = new Set(takenList);
              expect(sut.has(worktreeAdminId(basename, sut))).toBe(false);
            },
          ),
        );
      });
    });
  });
});

describe('isUnsafeWorktreeId', () => {
  describe('Given an unsafe id component', () => {
    describe('When isUnsafeWorktreeId runs', () => {
      // `` (0x1f) is the highest control character — the inclusive
      // boundary of the `<= CONTROL_CHAR_MAX` guard.
      it.each(['', '.', '..', 'a/b', 'a\\b', 'a\tb', 'a\nb', `a${String.fromCharCode(0x1f)}b`])(
        'Then %j is unsafe',
        (name) => {
          // Arrange + Act
          const result = isUnsafeWorktreeId(name);

          // Assert
          expect(result).toBe(true);
        },
      );
    });
  });

  describe('Given a safe id component', () => {
    describe('When isUnsafeWorktreeId runs', () => {
      it.each(['shared', 'shared1', 'feature-x', 'a.b'])('Then %j is safe', (name) => {
        // Arrange + Act
        const result = isUnsafeWorktreeId(name);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

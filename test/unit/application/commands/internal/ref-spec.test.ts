import { describe, expect, it } from 'vitest';
import {
  applyRefspec,
  MAX_REFSPECS_PER_FETCH,
  parseRefspec,
} from '../../../../../src/application/commands/internal/ref-spec.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { RefName } from '../../../../../src/domain/objects/object-id.js';

describe('internal/ref-spec', () => {
  describe('parseRefspec', () => {
    describe("Given 'refs/heads/main:refs/remotes/origin/main'", () => {
      describe('When parseRefspec', () => {
        it('Then non-force, src/dst set, no wildcard', () => {
          // Arrange
          const sut = parseRefspec('refs/heads/main:refs/remotes/origin/main');

          // Assert
          expect(sut).toEqual({
            force: false,
            src: 'refs/heads/main',
            dst: 'refs/remotes/origin/main',
            hasWildcard: false,
          });
        });
      });
    });

    describe("Given '+refs/heads/main:refs/remotes/origin/main'", () => {
      describe('When parseRefspec', () => {
        it("Then force is true and '+' is stripped from src", () => {
          // Arrange
          const sut = parseRefspec('+refs/heads/main:refs/remotes/origin/main');

          // Assert
          expect(sut.force).toBe(true);
          expect(sut.src).toBe('refs/heads/main');
        });
      });
    });

    describe('Given a non-force refspec with no NUL byte', () => {
      describe('When parseRefspec', () => {
        it('Then does not throw the NUL-byte error', () => {
          // Arrange
          const sut = parseRefspec('refs/heads/main:refs/remotes/origin/main');

          // Assert
          expect(sut.force).toBe(false);
        });
      });
    });

    describe("Given 'refs/heads/*:refs/remotes/origin/*'", () => {
      describe('When parseRefspec', () => {
        it('Then hasWildcard is true', () => {
          // Arrange
          const sut = parseRefspec('refs/heads/*:refs/remotes/origin/*');

          // Assert
          expect(sut.hasWildcard).toBe(true);
        });
      });
    });

    describe('Given mismatched wildcards (src wild, dst not)', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with wildcard-mismatch reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec('refs/heads/*:refs/remotes/origin/main');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: 'refs/heads/*:refs/remotes/origin/main',
            reason: 'wildcard mismatch between src and dst',
          });
        });
      });
    });

    describe('Given a refspec with no colon', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with missing-separator reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec('refs/heads/main');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: 'refs/heads/main',
            reason: 'missing ":" separator',
          });
        });
      });
    });

    describe('Given a refspec with NUL byte', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with NUL-byte reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec('refs/heads/main:refs/remotes\0origin/main');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: 'refs/heads/main:refs/remotes\0origin/main',
            reason: 'contains NUL byte',
          });
        });
      });
    });

    describe('Given an empty src', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with non-empty reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec(':refs/heads/main');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: ':refs/heads/main',
            reason: 'src and dst must be non-empty',
          });
        });
      });
    });

    describe('Given an empty dst', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with non-empty reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec('refs/heads/main:');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: 'refs/heads/main:',
            reason: 'src and dst must be non-empty',
          });
        });
      });
    });

    describe('Given a refspec whose src has two "*"', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with at-most-one-star reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec('refs/*/heads/*:refs/remotes/origin/*');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: 'refs/*/heads/*:refs/remotes/origin/*',
            reason: 'each side may contain at most one "*"',
          });
        });
      });
    });

    describe('Given a refspec whose dst has two "*"', () => {
      describe('When parseRefspec', () => {
        it('Then throws REFSPEC_INVALID with at-most-one-star reason', () => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec('refs/heads/*:refs/*/origin/*');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw: 'refs/heads/*:refs/*/origin/*',
            reason: 'each side may contain at most one "*"',
          });
        });
      });
    });

    describe('Given a single-wildcard refspec on both sides', () => {
      describe('When parseRefspec', () => {
        it('Then accepts it without throwing the at-most-one-star error', () => {
          // Arrange
          const sut = parseRefspec('refs/heads/*:refs/remotes/origin/*');

          // Assert
          expect(sut.hasWildcard).toBe(true);
        });
      });
    });
  });

  describe('applyRefspec', () => {
    describe("Given wildcard spec and 'refs/heads/main'", () => {
      describe('When applyRefspec', () => {
        it("Then returns mapped 'refs/remotes/origin/main'", () => {
          // Arrange
          const spec = parseRefspec('refs/heads/*:refs/remotes/origin/*');

          // Act
          const sut = applyRefspec(spec, 'refs/heads/main' as RefName);

          // Assert
          expect(sut).toBe('refs/remotes/origin/main');
        });
      });
    });

    describe("Given wildcard spec and a non-matching ref ('refs/tags/v1')", () => {
      describe('When applyRefspec', () => {
        it('Then returns undefined', () => {
          // Arrange
          const spec = parseRefspec('refs/heads/*:refs/remotes/origin/*');

          // Act
          const sut = applyRefspec(spec, 'refs/tags/v1' as RefName);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given an exact (non-wildcard) spec and the matching ref', () => {
      describe('When applyRefspec', () => {
        it('Then returns dst', () => {
          // Arrange
          const spec = parseRefspec('refs/heads/main:refs/remotes/origin/main');

          // Act
          const sut = applyRefspec(spec, 'refs/heads/main' as RefName);

          // Assert
          expect(sut).toBe('refs/remotes/origin/main');
        });
      });
    });

    describe('Given an exact spec and a non-matching ref', () => {
      describe('When applyRefspec', () => {
        it('Then returns undefined', () => {
          // Arrange
          const spec = parseRefspec('refs/heads/main:refs/remotes/origin/main');

          // Act
          const sut = applyRefspec(spec, 'refs/heads/dev' as RefName);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a wildcard spec with a non-empty suffix and a ref matching prefix but not suffix', () => {
      describe('When applyRefspec', () => {
        it('Then returns undefined', () => {
          // Arrange
          const spec = parseRefspec('refs/heads/*/head:refs/remotes/*/head');

          // Act
          const sut = applyRefspec(spec, 'refs/heads/main/tail' as RefName);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a wildcard spec with a non-empty suffix and a fully matching ref', () => {
      describe('When applyRefspec', () => {
        it('Then captures only the segment between prefix and suffix', () => {
          // Arrange
          const spec = parseRefspec('refs/heads/*/head:refs/remotes/*/head');

          // Act
          const sut = applyRefspec(spec, 'refs/heads/main/head' as RefName);

          // Assert
          expect(sut).toBe('refs/remotes/main/head');
        });
      });
    });
  });

  describe('MAX_REFSPECS_PER_FETCH', () => {
    describe('Given a constant 1024', () => {
      describe('When read', () => {
        it('Then equals 1024', () => {
          // Arrange + Assert
          expect(MAX_REFSPECS_PER_FETCH).toBe(1024);
        });
      });
    });
  });
});

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

    describe('Given a refspec that fails a parse guard', () => {
      describe('When parseRefspec', () => {
        it.each([
          {
            raw: 'refs/heads/*:refs/remotes/origin/main',
            reason: 'wildcard mismatch between src and dst',
            label: 'mismatched wildcards (src wild, dst not)',
          },
          {
            raw: 'refs/heads/main',
            reason: 'missing ":" separator',
            label: 'a refspec with no colon',
          },
          {
            raw: 'refs/heads/main:refs/remotes\0origin/main',
            reason: 'contains NUL byte',
            label: 'a refspec with NUL byte',
          },
          {
            raw: ':refs/heads/main',
            reason: 'src and dst must be non-empty',
            label: 'an empty src',
          },
          {
            raw: 'refs/heads/main:',
            reason: 'src and dst must be non-empty',
            label: 'an empty dst',
          },
          {
            raw: 'refs/*/heads/*:refs/remotes/origin/*',
            reason: 'each side may contain at most one "*"',
            label: 'a refspec whose src has two "*"',
          },
          {
            raw: 'refs/heads/*:refs/*/origin/*',
            reason: 'each side may contain at most one "*"',
            label: 'a refspec whose dst has two "*"',
          },
        ])('Then $label throws REFSPEC_INVALID', ({ raw, reason }) => {
          // Arrange
          let caught: unknown;
          try {
            parseRefspec(raw);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFSPEC_INVALID',
            raw,
            reason,
          });
        });
      });
    });
  });

  describe('applyRefspec', () => {
    describe('Given a refspec and a matching ref', () => {
      describe('When applyRefspec runs', () => {
        it.each([
          {
            specSource: 'refs/heads/*:refs/remotes/origin/*',
            ref: 'refs/heads/main' as RefName,
            expected: 'refs/remotes/origin/main',
            label: 'a wildcard spec maps the ref to refs/remotes/origin/main',
          },
          {
            specSource: 'refs/heads/main:refs/remotes/origin/main',
            ref: 'refs/heads/main' as RefName,
            expected: 'refs/remotes/origin/main',
            label: 'an exact (non-wildcard) spec returns dst',
          },
          {
            specSource: 'refs/heads/*/head:refs/remotes/*/head',
            ref: 'refs/heads/main/head' as RefName,
            expected: 'refs/remotes/main/head',
            label:
              'a wildcard spec with a non-empty suffix captures only the segment between prefix and suffix',
          },
        ])('Then $label', ({ specSource, ref, expected }) => {
          // Arrange
          const spec = parseRefspec(specSource);

          // Act
          const sut = applyRefspec(spec, ref);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });

    describe('Given a refspec and a non-matching ref', () => {
      describe('When applyRefspec runs', () => {
        it.each([
          {
            specSource: 'refs/heads/*:refs/remotes/origin/*',
            ref: 'refs/tags/v1' as RefName,
            label: 'a wildcard spec',
          },
          {
            specSource: 'refs/heads/main:refs/remotes/origin/main',
            ref: 'refs/heads/dev' as RefName,
            label: 'an exact spec',
          },
          {
            specSource: 'refs/heads/*/head:refs/remotes/*/head',
            ref: 'refs/heads/main/tail' as RefName,
            label:
              'a wildcard spec with a non-empty suffix and a ref matching prefix but not suffix',
          },
        ])('Then $label returns undefined', ({ specSource, ref }) => {
          // Arrange
          const spec = parseRefspec(specSource);

          // Act
          const sut = applyRefspec(spec, ref);

          // Assert
          expect(sut).toBeUndefined();
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

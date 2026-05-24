import { describe, expect, it } from 'vitest';
import {
  enforceLiteralMustMatch,
  resolvePathspec,
} from '../../../../../src/application/commands/internal/resolve-pathspec.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

const path = (s: string): FilePath => s as FilePath;

const expectError = (fn: () => unknown, code: string): TsgitError => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('resolvePathspec', () => {
  describe('Given a single literal', () => {
    describe('When resolved', () => {
      it('Then hasGlob=false and the literal is must-match', () => {
        // Arrange
        const sut = resolvePathspec(['src/foo.ts']);

        // Assert
        expect(sut.hasGlob).toBe(false);
        expect(sut.literalMustMatch).toEqual(['src/foo.ts']);
      });
    });
  });

  describe('Given a single glob', () => {
    describe('When resolved', () => {
      it('Then hasGlob=true and literalMustMatch is empty', () => {
        // Arrange
        const sut = resolvePathspec(['*.ts']);

        // Assert
        expect(sut.hasGlob).toBe(true);
        expect(sut.literalMustMatch).toEqual([]);
      });
    });
  });

  describe('Given a mix of literal + glob + negation', () => {
    describe('When resolved', () => {
      it('Then literalMustMatch contains only positive literals', () => {
        // Arrange
        const sut = resolvePathspec(['src/foo', '*.ts', '!*.test.ts', '!src/skip']);

        // Assert
        expect(sut.literalMustMatch).toEqual(['src/foo']);
        expect(sut.hasGlob).toBe(true);
      });
    });
  });

  describe('Given a `!`-only spec', () => {
    describe('When resolved', () => {
      it('Then literalMustMatch is empty (negations are not must-match)', () => {
        // Arrange
        const sut = resolvePathspec(['!*.ts', '!src/skip']);

        // Assert
        expect(sut.literalMustMatch).toEqual([]);
        expect(sut.hasGlob).toBe(false);
      });
    });
  });

  describe('Given a pattern with `..`', () => {
    describe('When resolved', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO', () => {
        // Arrange + Assert
        expectError(() => resolvePathspec(['../escape']), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a `!`-prefixed pattern with `..`', () => {
    describe('When resolved', () => {
      it('Then the body validation still throws', () => {
        // Arrange + Assert
        expectError(() => resolvePathspec(['!../escape']), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given an empty pattern (`""`)', () => {
    describe('When resolved', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO via the validator', () => {
        // Arrange + Assert
        expectError(() => resolvePathspec(['']), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a bare `"!"`', () => {
    describe('When resolved', () => {
      it('Then the empty body throws PATHSPEC_OUTSIDE_REPO', () => {
        // Arrange + Assert
        expectError(() => resolvePathspec(['!']), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a pattern exceeding the per-pattern length cap', () => {
    describe('When resolved', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange — components are each ≤ 255 bytes (passes the working-tree
        // path validator) but the overall pattern is > 256 bytes (trips
        // the pathspec-specific cap that bounds regex compilation cost).
        const seg = 'a'.repeat(100);
        const huge = `${seg}/${seg}/${seg}`;
        expect(huge.length).toBeGreaterThan(256);

        // Act
        const err = expectError(() => resolvePathspec([huge]), 'INVALID_OPTION');

        // Assert
        const data = err.data as { option: string; reason: string };
        expect(data.option).toBe('paths');
        expect(data.reason).toMatch(/max length/i);
      });
    });
  });

  describe('Given a pattern with more than the **-token cap', () => {
    describe('When resolved', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange — `**/**/**/**/**/**` has six `**` tokens; cap is 4.
        const pattern = '**/**/**/**/**/**';

        // Act
        const err = expectError(() => resolvePathspec([pattern]), 'INVALID_OPTION');

        // Assert
        const data = err.data as { option: string; reason: string };
        expect(data.option).toBe('paths');
        expect(data.reason).toMatch(/\*\*-token count/);
      });
    });
  });

  describe('Given a pattern with exactly the **-token cap (4 tokens)', () => {
    describe('When resolved', () => {
      it('Then accepts (boundary)', () => {
        // Arrange + Assert
        // Kills the `>` → `>=` mutant on the **-cap.
        expect(() => resolvePathspec(['**/**/**/**'])).not.toThrow();
      });
    });
  });

  describe('Given a non-negated single-char pattern', () => {
    describe('When resolved', () => {
      it('Then it does NOT throw (the `!`-strip slices only when `raw.startsWith("!")`)', () => {
        // Arrange + Assert
        // Kills L40 StringLiteral `'!'` → `""`: with `startsWith("")` always
        // true, `body` would become `'x'.slice(1)` === `''`, which the
        // working-tree validator rejects with PATHSPEC_OUTSIDE_REPO.
        expect(() => resolvePathspec(['x'])).not.toThrow();
      });
    });
  });

  describe('Given a pattern exactly at the byte cap (256 bytes)', () => {
    describe('When resolved', () => {
      it('Then it does NOT throw (boundary)', () => {
        // Arrange — 127 + 1 (`/`) + 128 = exactly 256 UTF-8 bytes; each
        // component is ≤ 255 bytes so the working-tree validator passes.
        const pattern = `${'a'.repeat(127)}/${'a'.repeat(128)}`;
        // Assert
        expect(PATTERN_BYTE_LENGTH(pattern)).toBe(256);

        // Act / Assert — kills L51 EqualityOperator `>` → `>=`.
        expect(() => resolvePathspec([pattern])).not.toThrow();
      });
    });
  });

  describe('Given ten consecutive `*`', () => {
    describe('When resolved', () => {
      it('Then it throws INVALID_OPTION (counts 5 `**` pairs, over the cap)', () => {
        // Arrange + Assert
        // Kills L66 cond1 `===`→`!==` and cond2 `===`→`!==`: both `!==`
        // mutants undercount `**********` to ≤ 4, so they would NOT throw.
        const err = expectError(() => resolvePathspec(['**********']), 'INVALID_OPTION');
        expect((err.data as { reason: string }).reason).toMatch(/\*\*-token count/);
      });
    });
  });

  describe('Given a pattern of isolated single `*` separated by literals', () => {
    describe('When resolved', () => {
      it('Then it does NOT throw (zero `**` pairs)', () => {
        // Arrange + Assert
        // Kills L66 cond1 `===`→`true` and cond2 `===`→`true`: forcing
        // either operand true makes `a*a*a*a*a*` count 5 pairs and throw.
        expect(() => resolvePathspec(['a*a*a*a*a*'])).not.toThrow();
      });
    });
  });
});

const PATTERN_BYTE_LENGTH = (s: string): number => new TextEncoder().encode(s).byteLength;

describe('enforceLiteralMustMatch', () => {
  describe('Given a literal that appears verbatim in matched', () => {
    describe('When checked', () => {
      it('Then no throw', () => {
        // Arrange + Assert
        expect(() =>
          enforceLiteralMustMatch([path('src/foo.ts')], [path('src/foo.ts'), path('other')]),
        ).not.toThrow();
      });
    });
  });

  describe('Given a literal whose descendant appears in matched (literal acts as dir prefix)', () => {
    describe('When checked', () => {
      it('Then no throw', () => {
        // Arrange + Assert
        expect(() => enforceLiteralMustMatch([path('src')], [path('src/foo.ts')])).not.toThrow();
      });
    });
  });

  describe('Given a literal with no direct or prefix match', () => {
    describe('When checked', () => {
      it('Then throws PATHSPEC_NO_MATCH with the missing literal', () => {
        // Arrange + Assert
        const err = expectError(
          () => enforceLiteralMustMatch([path('nope.txt')], [path('other.ts')]),
          'PATHSPEC_NO_MATCH',
        );
        expect((err.data as { pattern: string }).pattern).toBe('nope.txt');
      });
    });
  });

  describe('Given multiple literals where one is missing', () => {
    describe('When checked', () => {
      it('Then throws with the missing one', () => {
        // Arrange + Assert
        const err = expectError(
          () => enforceLiteralMustMatch([path('found'), path('missing')], [path('found/x')]),
          'PATHSPEC_NO_MATCH',
        );
        expect((err.data as { pattern: string }).pattern).toBe('missing');
      });
    });
  });

  describe('Given no literals (empty list)', () => {
    describe('When checked', () => {
      it('Then no throw regardless of matched', () => {
        // Arrange + Assert
        expect(() => enforceLiteralMustMatch([], [])).not.toThrow();
      });
    });
  });
});

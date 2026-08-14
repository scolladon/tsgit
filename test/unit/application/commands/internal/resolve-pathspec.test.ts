import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertNoSymlinkedLeadingPath,
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
  describe('Given a set of pathspec patterns', () => {
    describe('When resolved', () => {
      it.each([
        {
          patterns: ['src/foo.ts'],
          hasGlob: false,
          literalMustMatch: ['src/foo.ts'],
          label: 'a single literal is hasGlob=false and the literal is must-match',
        },
        {
          patterns: ['*.ts'],
          hasGlob: true,
          literalMustMatch: [],
          label: 'a single glob is hasGlob=true and literalMustMatch is empty',
        },
        {
          patterns: ['src/foo', '*.ts', '!*.test.ts', '!src/skip'],
          hasGlob: true,
          literalMustMatch: ['src/foo'],
          label:
            'a mix of literal + glob + negation has literalMustMatch containing only positive literals',
        },
        {
          patterns: ['!*.ts', '!src/skip'],
          hasGlob: false,
          literalMustMatch: [],
          label: 'a `!`-only spec has an empty literalMustMatch (negations are not must-match)',
        },
      ])('Then $label', ({ patterns, hasGlob, literalMustMatch }) => {
        // Arrange
        const result = resolvePathspec(patterns);

        // Assert
        expect(result.hasGlob).toBe(hasGlob);
        expect(result.literalMustMatch).toEqual(literalMustMatch);
      });
    });
  });

  describe('Given a set of pathspec patterns, for the leading-symlink scan targets', () => {
    describe('When resolved', () => {
      it.each([
        {
          patterns: ['src/foo.ts'],
          symlinkScanTargets: ['src/foo.ts'],
          label: 'a single literal is included',
        },
        {
          patterns: ['link/*.ts'],
          symlinkScanTargets: ['link/*.ts'],
          label: 'a single glob body is included (unlike literalMustMatch, which excludes it)',
        },
        {
          patterns: ['src/foo', '*.ts', '!*.test.ts', '!src/skip'],
          symlinkScanTargets: ['src/foo', '*.ts'],
          label: 'a mix of literal + glob keeps both, negated entries excluded',
        },
        {
          patterns: ['!*.ts', '!src/skip'],
          symlinkScanTargets: [],
          label: 'a `!`-only spec has an empty scan-target list',
        },
      ])('Then $label', ({ patterns, symlinkScanTargets }) => {
        // Arrange
        const result = resolvePathspec(patterns);

        // Assert
        expect(result.symlinkScanTargets).toEqual(symlinkScanTargets);
      });
    });
  });

  describe('Given a pattern whose body resolves outside the repo', () => {
    describe('When resolved', () => {
      it.each([
        { pattern: '../escape', label: 'a pattern with `..`' },
        {
          pattern: '!../escape',
          label: 'a `!`-prefixed pattern with `..` (body validation still throws)',
        },
        { pattern: '', label: 'an empty pattern (`""`) via the validator' },
        { pattern: '!', label: 'a bare `"!"` (the empty body throws)' },
      ])('Then $label throws PATHSPEC_OUTSIDE_REPO', ({ pattern }) => {
        // Arrange + Assert
        expectError(() => resolvePathspec([pattern]), 'PATHSPEC_OUTSIDE_REPO');
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

  describe('Given a pattern at a non-throwing boundary', () => {
    describe('When resolved', () => {
      it.each([
        {
          pattern: '**/**/**/**',
          // Kills the `>` → `>=` mutant on the **-cap.
          label: 'exactly the **-token cap (4 tokens) accepts (boundary)',
        },
        {
          pattern: 'x',
          // Kills L40 StringLiteral `'!'` → `""`: with `startsWith("")`
          // always true, `body` would become `'x'.slice(1)` === `''`, which
          // the working-tree validator rejects with PATHSPEC_OUTSIDE_REPO.
          label:
            'a non-negated single-char pattern does NOT throw (the `!`-strip slices only when `raw.startsWith("!")`)',
        },
        {
          pattern: 'a*a*a*a*a*',
          // Kills L66 cond1 `===`→`true` and cond2 `===`→`true`: forcing
          // either operand true makes `a*a*a*a*a*` count 5 pairs and throw.
          label:
            'a pattern of isolated single `*` separated by literals does NOT throw (zero `**` pairs)',
        },
      ])('Then $label', ({ pattern }) => {
        // Arrange + Assert
        expect(() => resolvePathspec([pattern])).not.toThrow();
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
});

const PATTERN_BYTE_LENGTH = (s: string): number => new TextEncoder().encode(s).byteLength;

describe('enforceLiteralMustMatch', () => {
  describe('Given literals and matched paths that satisfy every literal', () => {
    describe('When checked', () => {
      it.each([
        {
          literals: [path('src/foo.ts')],
          matched: [path('src/foo.ts'), path('other')],
          label: 'a literal that appears verbatim in matched',
        },
        {
          literals: [path('src')],
          matched: [path('src/foo.ts')],
          label: 'a literal whose descendant appears in matched (literal acts as dir prefix)',
        },
        { literals: [], matched: [], label: 'no literals (empty list), regardless of matched' },
      ])('Then $label: no throw', ({ literals, matched }) => {
        // Arrange + Assert
        expect(() => enforceLiteralMustMatch(literals, matched)).not.toThrow();
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
});

const expectAsyncError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('assertNoSymlinkedLeadingPath', () => {
  describe('Given a literal naming a file beyond a symlink pointing outside the repo', () => {
    describe('When checked', () => {
      it('Then throws PATHSPEC_BEYOND_SYMLINK carrying the literal', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('/outside-the-repo', `${ctx.layout.workDir}/dir`);

        // Act + Assert
        const err = await expectAsyncError(
          () => assertNoSymlinkedLeadingPath(ctx, [path('dir/file')]),
          'PATHSPEC_BEYOND_SYMLINK',
        );
        expect((err.data as { path: string }).path).toBe('dir/file');
      });
    });
  });

  describe('Given a literal naming a file beyond a symlink pointing inside the repo', () => {
    describe('When checked', () => {
      it('Then throws PATHSPEC_BEYOND_SYMLINK — shape-based, not containment-based', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('inside-target', `${ctx.layout.workDir}/dir`);

        // Act + Assert
        await expectAsyncError(
          () => assertNoSymlinkedLeadingPath(ctx, [path('dir/file')]),
          'PATHSPEC_BEYOND_SYMLINK',
        );
      });
    });
  });

  describe('Given a literal naming an untracked, nonexistent file beyond the link', () => {
    describe('When checked', () => {
      it('Then it still throws PATHSPEC_BEYOND_SYMLINK (only the leading component is scanned)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('/outside-the-repo', `${ctx.layout.workDir}/dir`);

        // Act + Assert
        await expectAsyncError(
          () => assertNoSymlinkedLeadingPath(ctx, [path('dir/never-created.txt')]),
          'PATHSPEC_BEYOND_SYMLINK',
        );
      });
    });
  });

  describe('Given a literal whose leaf itself is the symlink', () => {
    describe('When checked', () => {
      it('Then it does not throw (git stages a symlinked leaf as 120000)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('target.txt', `${ctx.layout.workDir}/link`);

        // Act + Assert
        await expect(assertNoSymlinkedLeadingPath(ctx, [path('link')])).resolves.toBeUndefined();
      });
    });
  });

  describe('Given literals with no symlinked leading component', () => {
    describe('When checked', () => {
      it('Then it does not throw', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);

        // Act + Assert
        await expect(
          assertNoSymlinkedLeadingPath(ctx, [path('dir/file'), path('top-level.txt')]),
        ).resolves.toBeUndefined();
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertNoSymlinkedLeadingPath,
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
  describe('Given a pattern holding a lone surrogate', () => {
    describe('When resolved', () => {
      it('Then the literal carries the replacement character', () => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(['\uDCFF.txt']);

        // Assert
        expect(result.literalMustMatch).toEqual(['\uFFFD.txt']);
      });
    });
  });

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
          symlinkScanTargets: ['src/foo', '*.ts', '*.test.ts', 'src/skip'],
          label:
            'a mix of literal + glob keeps both, and negated entries are scanned too (git refuses a negated pathspec beyond a symlink exactly like a positive one)',
        },
        {
          patterns: ['!*.ts', '!src/skip'],
          symlinkScanTargets: ['*.ts', 'src/skip'],
          label: 'a `!`-only spec still scans every negated body',
        },
      ])('Then $label', ({ patterns, symlinkScanTargets }) => {
        // Arrange
        const pathspecPatterns = patterns;

        // Act
        const result = resolvePathspec(pathspecPatterns);

        // Assert
        expect(result.symlinkScanTargets).toEqual(symlinkScanTargets);
      });
    });
  });

  describe('Given patterns carrying `.` path components', () => {
    describe('When resolved', () => {
      it.each([
        { patterns: ['.'], literalMustMatch: [''], label: 'a bare `.` names the whole tree' },
        { patterns: ['./'], literalMustMatch: [''], label: '`./` names the whole tree' },
        { patterns: ['./a.txt'], literalMustMatch: ['a.txt'], label: 'a leading `./` collapses' },
        {
          patterns: ['d/.'],
          literalMustMatch: ['d/'],
          label: 'a trailing `/.` collapses to a directory',
        },
        { patterns: ['d/./b'], literalMustMatch: ['d/b'], label: 'an inner `/./` collapses' },
        { patterns: ['d/'], literalMustMatch: ['d/'], label: 'a trailing `/` names a directory' },
        { patterns: ['d/./'], literalMustMatch: ['d/'], label: 'a trailing `/./` collapses' },
        { patterns: ['d//b'], literalMustMatch: ['d/b'], label: 'a doubled `/` collapses' },
        { patterns: ['d//'], literalMustMatch: ['d/'], label: 'a doubled trailing `/` collapses' },
      ])('Then $label', ({ patterns, literalMustMatch }) => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(patterns);

        // Assert
        expect(result.literalMustMatch).toEqual(literalMustMatch);
        expect(result.symlinkScanTargets).toEqual(literalMustMatch.filter((t) => t !== ''));
      });
    });

    describe('When a directory pattern is matched', () => {
      it('Then it selects the paths beneath the directory but not a file of that name', () => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(['d/./']);

        // Assert
        expect(result.matcher[0]?.compiled.test('d/b')).toBe(true);
        expect(result.matcher[0]?.compiled.test('d')).toBe(false);
        expect(result.matcher[0]?.compiled.test('db')).toBe(false);
      });
    });

    describe('When the whole-tree pattern is matched', () => {
      it('Then it selects every path, nested ones included', () => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(['.']);

        // Assert
        expect(result.matcher[0]?.compiled.test('a.txt')).toBe(true);
        expect(result.matcher[0]?.compiled.test('d/b')).toBe(true);
      });
    });

    describe('When a negated `./` pattern is matched', () => {
      it('Then it excludes the collapsed path', () => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(['!./a.txt']);

        // Assert
        expect(result.matcher[0]?.negated).toBe(true);
        expect(result.matcher[0]?.compiled.test('a.txt')).toBe(true);
        expect(result.literalMustMatch).toEqual([]);
        expect(result.symlinkScanTargets).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a pattern holding a backslash', () => {
    describe('When resolved', () => {
      it('Then it is one wildcard entry that is never a must-match literal', () => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(['a\\*b']);

        // Assert
        expect(result.matcher.map((e) => [e.body, e.isLiteral])).toEqual([['a\\*b', false]]);
        expect(result.literalMustMatch).toEqual([]);
        expect(result.hasGlob).toBe(true);
      });

      it.each([
        { pattern: '../a\\b', label: 'a leading `..` component' },
        { pattern: 'a\\b/../x', label: 'an inner `..` component' },
        { pattern: '/a\\b', label: 'a leading `/`' },
        { pattern: 'a\\b\0', label: 'a NUL byte' },
        { pattern: 'a\\b\u0001', label: 'a control byte' },
        { pattern: 'a\\b/.git/x', label: 'a `.git` component' },
        { pattern: `a\\${'b'.repeat(5000)}`, label: 'an over-long body' },
      ])('Then $label is still refused', ({ pattern }) => {
        // Arrange + Assert
        expectError(() => resolvePathspec([pattern]), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a backslash body refused for another rule', () => {
    describe('When resolved', () => {
      it('Then the refusal names the body as typed', () => {
        // Arrange
        const sut = resolvePathspec;
        let caught: unknown;

        // Act
        try {
          sut(['a\\b/../x']);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'PATHSPEC_OUTSIDE_REPO',
          path: 'a\\b/../x',
        });
      });
    });
  });

  describe('Given backslash bodies, for the leading-symlink scan targets', () => {
    describe('When resolved', () => {
      it.each([
        { patterns: ['d/a\\b'], targets: ['d/a'], label: 'the bytes before the backslash' },
        { patterns: ['a\\b'], targets: ['a'], label: 'a bare prefix' },
        { patterns: ['\\x'], targets: [], label: 'an empty prefix, dropped' },
        { patterns: ['d/a*b\\c'], targets: ['d/a'], label: 'the bytes before the first wildcard' },
        { patterns: ['d/x\\*'], targets: ['d/x'], label: 'the prefix of an escaped wildcard' },
        { patterns: ['link/*.ts'], targets: ['link/*.ts'], label: 'a backslash-free body, whole' },
      ])('Then $label', ({ patterns, targets }) => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut(patterns);

        // Assert
        expect(result.symlinkScanTargets).toEqual(targets);
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

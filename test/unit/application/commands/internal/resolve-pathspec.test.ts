import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertNoSymlinkedLeadingPath,
  resolvePathspec,
} from '../../../../../src/application/commands/internal/resolve-pathspec.js';
import { pathTooLong, permissionDenied, TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import { matchesPathspec } from '../../../../../src/domain/pathspec/match-pathspec.js';
import type { Context } from '../../../../../src/ports/context.js';

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
      ])('Then $label is still refused', ({ pattern }) => {
        // Arrange + Assert
        expectError(() => resolvePathspec([pattern]), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a backslash body longer than 4096 bytes', () => {
    describe('When resolved', () => {
      it('Then it is one wildcard entry', () => {
        // Arrange
        const sut = resolvePathspec;
        const pattern = `a\\b/${Array.from({ length: 21 }, () => 'c'.repeat(200)).join('/')}`;

        // Act
        const result = sut([pattern]);

        // Assert
        expect(result.matcher.map((e) => [e.body, e.isLiteral])).toEqual([[pattern, false]]);
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

  describe('Given a pathspec no budget limits', () => {
    const LITERAL_300 = `${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(98)}`;
    const STAR_SHAPE = `${'a'.repeat(200)}/${'b'.repeat(200)}/x`;

    describe('When resolved', () => {
      it.each([
        {
          label: 'a 300-byte literal',
          pattern: LITERAL_300,
          entry: { body: LITERAL_300, isLiteral: true, negated: false },
          target: LITERAL_300,
        },
        {
          label: 'a 300-byte single component',
          pattern: 's'.repeat(300),
          entry: { body: 's'.repeat(300), isLiteral: true, negated: false },
          target: 's'.repeat(300),
        },
        {
          label: 'five `**`',
          pattern: '**a**b**c**d**x',
          entry: { body: '**a**b**c**d**x', isLiteral: false, negated: false },
          target: STAR_SHAPE.replace('/x', '/a-b-c-d-x'),
        },
        {
          label: 'ten `*`',
          pattern: '**********',
          entry: { body: '**********', isLiteral: false, negated: false },
          target: STAR_SHAPE,
        },
        {
          label: 'a 300-byte negated body',
          pattern: `!${LITERAL_300}`,
          entry: { body: LITERAL_300, isLiteral: true, negated: true },
          target: undefined,
        },
        {
          label: 'a 300-byte directory-only body',
          pattern: `${LITERAL_300}/`,
          entry: { body: `${LITERAL_300}/`, isLiteral: true, negated: false },
          target: `${LITERAL_300}/x`,
        },
      ])('Then $label resolves to its entry', ({ pattern, entry, target }) => {
        // Arrange
        const sut = resolvePathspec;

        // Act
        const result = sut([pattern]);

        // Assert
        expect(
          result.matcher.map((e) => ({ body: e.body, isLiteral: e.isLiteral, negated: e.negated })),
        ).toEqual([entry]);
        if (target !== undefined) {
          expect(matchesPathspec(result.matcher, path(target))).toBe(true);
        }
      });
    });
  });

  describe('Given a pattern at a non-throwing boundary', () => {
    describe('When resolved', () => {
      it.each([
        {
          pattern: 'x',
          // Kills L40 StringLiteral `'!'` → `""`: with `startsWith("")`
          // always true, `body` would become `'x'.slice(1)` === `''`, which
          // the working-tree validator rejects with PATHSPEC_OUTSIDE_REPO.
          label:
            'a non-negated single-char pattern does NOT throw (the `!`-strip slices only when `raw.startsWith("!")`)',
        },
      ])('Then $label', ({ pattern }) => {
        // Arrange + Assert
        expect(() => resolvePathspec([pattern])).not.toThrow();
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

const refusing = (ctx: Context, name: string, fault: (path: string) => TsgitError): Context => {
  const refused = `${ctx.layout.workDir}/${name}`;
  const fs = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
      return async (p: string) => {
        if (p === refused) throw fault(p);
        return target.lstat(p);
      };
    },
  });
  return { ...ctx, fs };
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

  describe('Given a target whose leading prefix the file system refuses as too long', () => {
    describe('When checked', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = refusing(createMemoryContext(), 'long', pathTooLong);

        // Act + Assert
        await expect(assertNoSymlinkedLeadingPath(ctx, [path('long/x')])).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a target whose leading prefix is refused with PERMISSION_DENIED', () => {
    describe('When checked', () => {
      it('Then it rejects with that fault', async () => {
        // Arrange
        const ctx = refusing(createMemoryContext(), 'long', permissionDenied);

        // Act
        const err = await expectAsyncError(
          () => assertNoSymlinkedLeadingPath(ctx, [path('long/x')]),
          'PERMISSION_DENIED',
        );

        // Assert
        expect(err.data).toEqual(permissionDenied(`${ctx.layout.workDir}/long`).data);
      });
    });
  });

  describe('Given a too-long prefix target followed by a target beyond a symlink', () => {
    describe('When checked', () => {
      it('Then the later target is still refused', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await seeded.fs.symlink('/outside-the-repo', `${seeded.layout.workDir}/dir`);
        const ctx = refusing(seeded, 'long', pathTooLong);

        // Act
        const err = await expectAsyncError(
          () => assertNoSymlinkedLeadingPath(ctx, [path('long/x'), path('dir/file')]),
          'PATHSPEC_BEYOND_SYMLINK',
        );

        // Assert
        expect((err.data as { path: string }).path).toBe('dir/file');
      });
    });
  });
});

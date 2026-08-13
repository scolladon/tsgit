import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { createLeadingPathScanner } from '../../../../../src/application/primitives/internal/symlinked-leading-path.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const path = (s: string): FilePath => s as FilePath;

/** Wraps `ctx.fs.lstat` to count calls per absolute path, leaving every other member untouched. */
const withLstatCallCounter = (
  ctx: Context,
): { readonly ctx: Context; readonly calls: string[] } => {
  const calls: string[] = [];
  const baseLstat = ctx.fs.lstat;
  const fs = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop === 'lstat') {
        return async (p: string) => {
          calls.push(p);
          return baseLstat(p);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ctx: { ...ctx, fs }, calls };
};

/** Wraps `ctx.fs.lstat` so any lstat of `failPath` throws `err` instead of resolving normally. */
const withLstatFailure = (ctx: Context, failPath: string, err: TsgitError): Context => {
  const baseLstat = ctx.fs.lstat;
  const fs = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop === 'lstat') {
        return async (p: string) => {
          if (p === failPath) throw err;
          return baseLstat(p);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...ctx, fs };
};

describe('createLeadingPathScanner', () => {
  describe('Given a leading directory that is a symlink pointing outside the repo', () => {
    describe('When hasSymlinkedLeadingPath is checked for a file beneath it', () => {
      it('Then it returns true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('/outside-the-repo', `${ctx.layout.workDir}/dir`);
        const sut = createLeadingPathScanner(ctx);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('dir/file'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a leading directory that is a symlink pointing inside the repo', () => {
    describe('When hasSymlinkedLeadingPath is checked for a file beneath it', () => {
      it('Then it returns true (shape-based — the target location does not matter)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('inside-target', `${ctx.layout.workDir}/dir`);
        const sut = createLeadingPathScanner(ctx);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('dir/file'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given only the leaf itself is a symlink (every leading component is a plain directory)', () => {
    describe('When hasSymlinkedLeadingPath is checked', () => {
      it('Then it returns false — the leaf is never scanned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);
        await ctx.fs.symlink('target.txt', `${ctx.layout.workDir}/dir/leaf-link`);
        const sut = createLeadingPathScanner(ctx);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('dir/leaf-link'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a single-segment path with no leading directory at all', () => {
    describe('When hasSymlinkedLeadingPath is checked', () => {
      it('Then it returns false without any lstat call', async () => {
        // Arrange
        const { ctx, calls } = withLstatCallCounter(createMemoryContext());
        const sut = createLeadingPathScanner(ctx);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('file'));

        // Assert
        expect(result).toBe(false);
        expect(calls).toHaveLength(0);
      });
    });
  });

  describe('Given a leading component that does not exist on disk', () => {
    describe('When hasSymlinkedLeadingPath is checked', () => {
      it('Then it returns false (a missing prefix is not a symlink)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = createLeadingPathScanner(ctx);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('missing/file'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a leading component whose lstat fails with a non-FILE_NOT_FOUND error', () => {
    describe('When hasSymlinkedLeadingPath is checked', () => {
      it('Then the error propagates instead of being swallowed', async () => {
        // Arrange
        const seed = createMemoryContext();
        const failPath = `${seed.layout.workDir}/dir`;
        const permissionDenied = new TsgitError({ code: 'PERMISSION_DENIED', path: failPath });
        const ctx = withLstatFailure(seed, failPath, permissionDenied);
        const sut = createLeadingPathScanner(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.hasSymlinkedLeadingPath(path('dir/file'));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a multi-literal pathspec set sharing a common leading prefix', () => {
    describe('When hasSymlinkedLeadingPath is called once per literal on the same scanner', () => {
      it('Then each distinct prefix is lstat-ed exactly once (per-directory memo)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir/sub`);
        const { ctx: countedCtx, calls } = withLstatCallCounter(ctx);
        const sut = createLeadingPathScanner(countedCtx);

        // Act
        await sut.hasSymlinkedLeadingPath(path('dir/sub/a.txt'));
        await sut.hasSymlinkedLeadingPath(path('dir/sub/b.txt'));

        // Assert — distinct prefixes across both literals are `dir` and `dir/sub`;
        // a correct memo issues exactly one lstat per distinct prefix (2 total),
        // not one per literal-prefix pair (4).
        expect(calls).toHaveLength(2);
        expect(calls.sort()).toEqual(
          [`${ctx.layout.workDir}/dir`, `${ctx.layout.workDir}/dir/sub`].sort(),
        );
      });
    });
  });

  describe('Given a leading prefix chain where an intermediate directory is missing', () => {
    describe('When hasSymlinkedLeadingPath is checked', () => {
      it('Then walking stops at the missing prefix and a deeper prefix is never lstat-ed', async () => {
        // Arrange — a real filesystem could never report `dir/deeper` as present
        // while `dir` itself is missing; the lstat double simulates exactly that
        // shape to prove the scanner stops at the first missing prefix rather
        // than trusting (or even reaching) a deeper one.
        const seed = createMemoryContext();
        const dirPath = `${seed.layout.workDir}/dir`;
        const deeperPath = `${seed.layout.workDir}/dir/deeper`;
        const calls: string[] = [];
        const fs = new Proxy(seed.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async (p: string) => {
                calls.push(p);
                if (p === dirPath) throw new TsgitError({ code: 'FILE_NOT_FOUND', path: dirPath });
                throw new Error(`unexpected lstat in this test: ${p}`);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const ctx = { ...seed, fs };
        const sut = createLeadingPathScanner(ctx);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('dir/deeper/file'));

        // Assert
        expect(result).toBe(false);
        expect(calls).toEqual([dirPath]);
        expect(calls).not.toContain(deeperPath);
      });
    });
  });
});

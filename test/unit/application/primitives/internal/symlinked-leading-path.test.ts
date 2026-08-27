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

  describe('Given a symlinked leading directory pointing outside the repo', () => {
    describe('When unlinkSymlinkedLeadingComponent runs for a file beneath it', () => {
      it('Then the symlink is removed via fs.rm', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dirPath = `${ctx.layout.workDir}/dir`;
        await ctx.fs.symlink('/outside-the-repo', dirPath);
        const rmSpy: string[] = [];
        const fs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'rm') {
              return async (p: string) => {
                rmSpy.push(p);
                return Reflect.get(target, 'rm', receiver).call(target, p);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const sut = createLeadingPathScanner({ ...ctx, fs });

        // Act
        await sut.unlinkSymlinkedLeadingComponent(path('dir/file'));

        // Assert
        expect(rmSpy).toEqual([dirPath]);
      });
    });
  });

  describe('Given a leading component that does not exist on disk', () => {
    describe('When unlinkSymlinkedLeadingComponent runs', () => {
      it('Then it is a no-op — nothing to unlink', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const rmSpy: string[] = [];
        const fs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'rm') {
              return async (p: string) => {
                rmSpy.push(p);
                return Reflect.get(target, 'rm', receiver).call(target, p);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const sut = createLeadingPathScanner({ ...ctx, fs });

        // Act
        await sut.unlinkSymlinkedLeadingComponent(path('missing/file'));

        // Assert
        expect(rmSpy).toHaveLength(0);
      });
    });
  });

  describe('Given only the leaf itself is a symlink (every leading component is a plain directory)', () => {
    describe('When unlinkSymlinkedLeadingComponent runs', () => {
      it('Then the leaf is left untouched — the leaf is never scanned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);
        await ctx.fs.symlink('target.txt', `${ctx.layout.workDir}/dir/leaf-link`);
        const sut = createLeadingPathScanner(ctx);

        // Act
        await sut.unlinkSymlinkedLeadingComponent(path('dir/leaf-link'));

        // Assert
        expect((await ctx.fs.lstat(`${ctx.layout.workDir}/dir/leaf-link`)).isSymbolicLink).toBe(
          true,
        );
      });
    });
  });

  describe('Given a leading prefix chain with a plain directory followed by a deeper symlinked directory', () => {
    describe('When unlinkSymlinkedLeadingComponent runs for a file beneath both', () => {
      it('Then walking continues past the plain prefix and unlinks the deeper symlink', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);
        const deeperPath = `${ctx.layout.workDir}/dir/deeper`;
        await ctx.fs.symlink('/outside-the-repo', deeperPath);
        const sut = createLeadingPathScanner(ctx);

        // Act
        await sut.unlinkSymlinkedLeadingComponent(path('dir/deeper/file'));

        // Assert
        expect(await ctx.fs.exists(deeperPath)).toBe(false);
        expect((await ctx.fs.lstat(`${ctx.layout.workDir}/dir`)).isDirectory).toBe(true);
      });
    });
  });

  describe('Given a leading component whose lstat fails with a non-FILE_NOT_FOUND error', () => {
    describe('When unlinkSymlinkedLeadingComponent runs', () => {
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
          await sut.unlinkSymlinkedLeadingComponent(path('dir/file'));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given hasSymlinkedLeadingPath already classified a prefix on a scanner', () => {
    describe('When unlinkSymlinkedLeadingComponent scans a different path sharing that prefix', () => {
      it('Then the cached classification is reused — one lstat total for the shared prefix', async () => {
        // Arrange — proves the delete-skip check (hasSymlinkedLeadingPath) and
        // the write-unlink check (unlinkSymlinkedLeadingComponent) consult the
        // SAME per-directory memo, not two independent ones.
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);
        const { ctx: countedCtx, calls } = withLstatCallCounter(ctx);
        const sut = createLeadingPathScanner(countedCtx);
        await sut.hasSymlinkedLeadingPath(path('dir/a.txt'));

        // Act
        await sut.unlinkSymlinkedLeadingComponent(path('dir/b.txt'));

        // Assert
        expect(calls).toHaveLength(1);
      });
    });
  });

  describe('Given a symlinked leading directory unlinked via unlinkSymlinkedLeadingComponent', () => {
    describe('When a real directory replaces it and a later, unrelated path scans the same prefix', () => {
      it('Then the memo is invalidated — the later scan re-lstats instead of reusing the stale symlink verdict', async () => {
        // Arrange
        const seed = createMemoryContext();
        const dirPath = `${seed.layout.workDir}/dir`;
        await seed.fs.symlink('/outside/target', dirPath);
        const { ctx, calls } = withLstatCallCounter(seed);
        const sut = createLeadingPathScanner(ctx);
        await sut.unlinkSymlinkedLeadingComponent(path('dir/a.txt'));
        await ctx.fs.mkdir(dirPath);

        // Act
        const result = await sut.hasSymlinkedLeadingPath(path('dir/b.txt'));

        // Assert — a stale memo would answer `true` from the first lstat's
        // cached 'symlink' verdict without ever re-checking; invalidation
        // forces a second lstat that observes the real directory.
        expect(result).toBe(false);
        expect(calls.filter((c) => c === dirPath)).toHaveLength(2);
      });
    });
  });

  describe('Given a shared scanner whose first write materialises a prefix previously classified missing', () => {
    describe('When unlinkSymlinkedLeadingComponent runs for a deeper path after that write', () => {
      it('Then the stale missing verdict does not block the walk — the deeper symlink is still unlinked', async () => {
        // Arrange — mirrors write-working-tree-file.ts's real sequence at
        // each write call site: unlinkSymlinkedLeadingComponent runs BEFORE
        // the write, and the write itself (ctx.fs.symlink here) auto-creates
        // missing parent directories per the FileSystem port contract. `a`
        // does not exist yet, so the first scan for `a/x` classifies `a` as
        // missing (nothing to unlink) and memoises it — a fresh scanner
        // would re-lstat `a` on the second call and correctly walk deeper
        // into the now-real `a` to find and unlink the `a/x` symlink; a
        // scanner that never invalidates the stale 'missing' verdict would
        // short-circuit at `a` and leave `a/x` in place.
        const ctx = createMemoryContext();
        const sut = createLeadingPathScanner(ctx);

        // Act
        await sut.unlinkSymlinkedLeadingComponent(path('a/x'));
        await ctx.fs.symlink('/outside-the-repo', `${ctx.layout.workDir}/a/x`);
        await sut.unlinkSymlinkedLeadingComponent(path('a/x/y'));

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a/x`)).toBe(false);
      });
    });
  });

  describe('Given a leading prefix chain whose first two segments are both missing, walked once via unlinkSymlinkedLeadingComponent', () => {
    describe('When a real directory and a deeper symlink later materialise there and hasSymlinkedLeadingPath scans the same chain', () => {
      it('Then the deeper symlink is still detected — the shallow prefix does not keep a stale missing verdict', async () => {
        // Arrange — the 'missing' branch must stop the walk and drop its own
        // memo entry, so a later scan re-lstats the now-real 'a' instead of
        // trusting a stale cached 'missing'. If the walk kept going instead
        // (missing branch skipped), it would ALSO cache the deeper 'a/dir'
        // prefix as 'missing' — a verdict that never gets invalidated once
        // 'a/dir' later becomes a real symlink, hiding it from every later scan.
        const ctx = createMemoryContext();
        const sut = createLeadingPathScanner(ctx);

        // Act — first scan while both 'a' and 'a/dir' are missing.
        await sut.unlinkSymlinkedLeadingComponent(path('a/dir/file'));
        // 'a/dir' materialises as a symlink (auto-creates 'a' as a real directory).
        await ctx.fs.symlink('/outside-the-repo', `${ctx.layout.workDir}/a/dir`);
        const result = await sut.hasSymlinkedLeadingPath(path('a/dir/file'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a prefix already classified and cached on a scanner', () => {
    describe('When invalidate is called for that exact prefix and a later path scans it again', () => {
      it('Then the memo entry is dropped and a fresh lstat runs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);
        const { ctx: countedCtx, calls } = withLstatCallCounter(ctx);
        const sut = createLeadingPathScanner(countedCtx);
        await sut.hasSymlinkedLeadingPath(path('dir/a.txt'));

        // Act
        sut.invalidate(path('dir'));
        await sut.hasSymlinkedLeadingPath(path('dir/b.txt'));

        // Assert
        expect(calls).toHaveLength(2);
      });
    });
  });

  describe('Given two concurrent probes of the same prefix, started before either lstat settles', () => {
    describe('When hasSymlinkedLeadingPath is called twice on one scanner without awaiting the first', () => {
      it('Then the prefix is lstat-ed exactly once — the second call joins the first in flight', async () => {
        // Arrange — a parallel delete wave and write wave sharing one scanner
        // can both probe the same leading prefix before either lstat settles;
        // a plain settled-value cache would miss on both and lstat twice.
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir`);
        const { ctx: countedCtx, calls } = withLstatCallCounter(ctx);
        const sut = createLeadingPathScanner(countedCtx);

        // Act — both calls start before either's lstat has resolved.
        const [first, second] = await Promise.all([
          sut.hasSymlinkedLeadingPath(path('dir/a.txt')),
          sut.hasSymlinkedLeadingPath(path('dir/b.txt')),
        ]);

        // Assert — single-flight: one lstat serves both callers.
        expect(first).toBe(false);
        expect(second).toBe(false);
        expect(calls).toEqual([`${ctx.layout.workDir}/dir`]);
      });
    });
  });
});

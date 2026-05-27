import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { isIgnored } from '../../../../src/application/primitives/is-ignored.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

afterEach(() => __resetConfigCacheForTests());

const path = (p: string): FilePath => p as FilePath;

const seedRepo = async (homeDir?: string) => {
  const ctx = homeDir === undefined ? createMemoryContext() : createMemoryContext({ homeDir });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('isIgnored', () => {
  describe('Given a root .gitignore with *.log and a matching path', () => {
    describe('When isIgnored is called', () => {
      it('Then the result is ignored with the matching rule provenance', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('foo.log') }]);

        // Assert
        expect(sut?.ignored).toBe(true);
        expect(sut?.source?.kind).toBe('gitignore');
        expect(sut?.source?.basedir).toBe('');
        expect(sut?.source?.line).toBe(1);
        expect(sut?.source?.pattern).toBe('*.log');
      });
    });
  });

  describe('Given a nested .gitignore with a matching path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.basedir is the nested directory and line/pattern come from that file', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '# header\n*.cache\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('sub/foo.cache') }]);

        // Assert
        expect(sut?.ignored).toBe(true);
        expect(sut?.source?.kind).toBe('gitignore');
        expect(sut?.source?.basedir).toBe('sub');
        expect(sut?.source?.line).toBe(2);
        expect(sut?.source?.pattern).toBe('*.cache');
      });
    });
  });

  describe('Given no matching rule', () => {
    describe('When isIgnored is called', () => {
      it('Then ignored is false and source is omitted', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('keep.txt') }]);

        // Assert
        expect(sut?.ignored).toBe(false);
        expect(sut?.source).toBeUndefined();
      });
    });
  });

  describe('Given a negated rule that re-includes a previously ignored path', () => {
    describe('When isIgnored is called', () => {
      it('Then ignored is false with no source (per ADR-163)', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n!keep.log\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('keep.log') }]);

        // Assert
        expect(sut?.ignored).toBe(false);
        expect(sut?.source).toBeUndefined();
      });
    });
  });

  describe('Given a directory-only rule and a directory path', () => {
    describe('When isIgnored is called with isDirectory:true', () => {
      it('Then the directory is ignored', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('build'), isDirectory: true }]);

        // Assert
        expect(sut?.ignored).toBe(true);
        expect(sut?.source?.pattern).toBe('build/');
      });
    });
  });

  describe('Given a directory-only rule and a non-directory path', () => {
    describe('When isIgnored is called with isDirectory omitted', () => {
      it('Then the rule does NOT match (default isDirectory is false)', async () => {
        // Arrange — exercises the `isDirectory ?? false` default branch.
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('build') }]);

        // Assert
        expect(sut?.ignored).toBe(false);
      });
    });
  });

  describe('Given an info/exclude file matches the path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.kind is "info"', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.txt\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('secret.txt') }]);

        // Assert
        expect(sut?.ignored).toBe(true);
        expect(sut?.source?.kind).toBe('info');
      });
    });
  });

  describe('Given the global excludes file matches the path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.kind is "global"', async () => {
        // Arrange — memory fs requires the global excludes path to live under
        // the same rootDir (DEFAULT_WORK_DIR = '/repo'); use '/repo/home' as
        // the home directory, mirroring the existing build-ignore-evaluator
        // test setup.
        const ctx = await seedRepo('/repo/home');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  excludesFile = ~/.gitignore_global\n',
        );
        await ctx.fs.writeUtf8('/repo/home/.gitignore_global', '*.swp\n');

        // Act
        const [sut] = await isIgnored(ctx, [{ path: path('foo.swp') }]);

        // Assert
        expect(sut?.ignored).toBe(true);
        expect(sut?.source?.kind).toBe('global');
      });
    });
  });

  describe('Given an empty queries array', () => {
    describe('When isIgnored is called', () => {
      it('Then it returns an empty result without touching the fs', async () => {
        // Arrange — kills the `length === 0` short-circuit.
        const ctx = await seedRepo();

        // Act
        const sut = await isIgnored(ctx, []);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given multiple queries', () => {
    describe('When isIgnored is called', () => {
      it('Then the result preserves input order', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        // Act
        const sut = await isIgnored(ctx, [
          { path: path('a.log') },
          { path: path('b.txt') },
          { path: path('c.log') },
        ]);

        // Assert
        expect(sut.map((r) => r.ignored)).toEqual([true, false, true]);
        expect(sut.map((r) => r.path)).toEqual(['a.log', 'b.txt', 'c.log']);
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When isIgnored is called', () => {
      it('Then the entry guard throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = createMemoryContext({ signal: controller.signal });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        let caught: unknown;
        try {
          await isIgnored(ctx, [{ path: path('foo.log') }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given a signal aborted during buildIgnoreEvaluator', () => {
    describe('When isIgnored is called with two queries', () => {
      it('Then the per-query guard throws OPERATION_ABORTED before query evaluation', async () => {
        // Arrange — wrap `readUtf8` so reading the root `.gitignore` (which
        // buildIgnoreEvaluator triggers) aborts the controller mid-call.
        // After buildEvaluator returns, the per-query guard at the loop top
        // fires before the first match runs.
        const controller = new AbortController();
        const ctx = createMemoryContext({ signal: controller.signal });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        const baseReadUtf8 = ctx.fs.readUtf8;
        const wrappedFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readUtf8') {
              return async (p: string): Promise<string> => {
                const result = await baseReadUtf8(p);
                if (p.endsWith('/.gitignore')) controller.abort();
                return result;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const wrappedCtx = { ...ctx, fs: wrappedFs };

        // Act
        let caught: unknown;
        try {
          await isIgnored(wrappedCtx, [{ path: path('a.log') }, { path: path('b.log') }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});

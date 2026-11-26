import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  buildIgnoreEvaluator,
  buildRepoIgnorePredicate,
} from '../../../../../src/application/commands/internal/build-ignore-evaluator.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/primitives/config-read.js';
import { MAX_GITIGNORE_BYTES } from '../../../../../src/application/primitives/types.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

afterEach(() => __resetConfigCacheForTests());

const seed = async (homeDir?: string) => {
  const ctx = homeDir === undefined ? createMemoryContext() : createMemoryContext({ homeDir });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('buildIgnoreEvaluator', () => {
  describe('Given no ignore sources', () => {
    describe('When built', () => {
      it('Then base is empty', async () => {
        // Arrange
        const ctx = await seed();

        // Act
        const sut = await buildIgnoreEvaluator(ctx);

        // Assert
        expect(sut.base).toEqual([]);
      });
    });
  });

  describe('Given root .gitignore + info/exclude + global', () => {
    describe('When built', () => {
      it('Then base contains all three in order with basedir="" for each', async () => {
        // Arrange
        const ctx = await seed('/repo/home');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, '*.tmp\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  excludesFile = ~/global\n',
        );
        await ctx.fs.writeUtf8('/repo/home/global', '*.swp\n');

        // Act
        const sut = await buildIgnoreEvaluator(ctx);

        // Assert — order is global → info → root. Each base level anchors
        // at the repo root (basedir === ''), so a mutant changing the
        // basedir assignment is killed.
        expect(sut.base).toHaveLength(3);
        expect(sut.base[0]?.basedir).toBe('');
        expect(sut.base[1]?.basedir).toBe('');
        expect(sut.base[2]?.basedir).toBe('');
        expect(sut.base[0]?.rules[0]?.pattern).toBe('*.swp');
        expect(sut.base[1]?.rules[0]?.pattern).toBe('*.tmp');
        expect(sut.base[2]?.rules[0]?.pattern).toBe('*.log');
      });
    });
  });

  describe('Given a built evaluator', () => {
    describe('When loadDirRules loads sub', () => {
      it('Then the config is not read again', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '*.tmp\n');
        // A cached config is revalidated by a stat, not re-read: every file
        // system call on the config counts, whatever its kind.
        let configTouches = 0;
        const countingFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            const member: unknown = Reflect.get(target, prop, receiver);
            if (typeof member !== 'function') return member;
            return (...args: unknown[]) => {
              if (typeof args[0] === 'string' && args[0].endsWith('/config')) configTouches += 1;
              return Reflect.apply(member, target, args);
            };
          },
        });
        const evaluator = await buildIgnoreEvaluator({ ...ctx, fs: countingFs });
        const touchesAtBuild = configTouches;
        const sut = evaluator.loadDirRules;

        // Act
        await sut('sub' as FilePath);

        // Assert
        expect(touchesAtBuild).toBeGreaterThan(0);
        expect(configTouches).toBe(touchesAtBuild);
      });
    });
  });

  describe('Given a directory holding a .gitignore', () => {
    describe('When loadDirRules loads it', () => {
      it('Then it yields the parsed rules of that file', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '*.tmp\n');
        const evaluator = await buildIgnoreEvaluator(ctx);
        const sut = evaluator.loadDirRules;

        // Act
        const result = await sut('sub' as FilePath);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.pattern).toBe('*.tmp');
        expect(result[0]?.lineNumber).toBe(1);
      });
    });
  });

  describe('Given a directory holding no .gitignore', () => {
    describe('When loadDirRules loads it', () => {
      it('Then it yields an empty ruleset', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/kept.txt`, 'kept\n');
        const evaluator = await buildIgnoreEvaluator(ctx);
        const sut = evaluator.loadDirRules;

        // Act
        const result = await sut('sub' as FilePath);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('buildRepoIgnorePredicate', () => {
  describe('Given no ignore sources', () => {
    describe('When called', () => {
      it('Then returns false for any path', async () => {
        // Arrange
        const ctx = await seed();
        const sut = await buildRepoIgnorePredicate(ctx);

        // Assert
        expect(await sut('foo.txt' as FilePath, false)).toBe(false);
        expect(await sut('sub' as FilePath, true)).toBe(false);
      });
    });
  });

  describe('Given a root .gitignore with `*.log`', () => {
    describe('When called for `foo.log`', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act / Assert
        expect(await sut('foo.log' as FilePath, false)).toBe(true);
      });
    });
  });

  describe('Given core.ignorecase true and a root *.log', () => {
    describe('When buildRepoIgnorePredicate tests X.LOG', () => {
      it('Then it is ignored', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tignorecase = true\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const ignored = await sut('X.LOG' as FilePath, false);

        // Assert
        expect(ignored).toBe(true);
      });
    });
  });

  describe('Given a root `*.log` ignore + a nested `!keep.log` re-include', () => {
    describe('When called for `sub/keep.log`', () => {
      it('Then returns false (negation wins)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '!keep.log\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const ignored = await sut('sub/keep.log' as FilePath, false);

        // Assert
        expect(ignored).toBe(false);
      });
    });
  });

  describe('Given the same root + nested rules', () => {
    describe('When called for `sub/other.log`', () => {
      it('Then returns true (only `keep.log` was re-included)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '!keep.log\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act / Assert
        expect(await sut('sub/other.log' as FilePath, false)).toBe(true);
      });
    });
  });

  describe('Given a directory-only rule `build/`', () => {
    describe('When called with isDirectory=true', () => {
      it('Then returns true; with false returns false', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act / Assert
        expect(await sut('build' as FilePath, true)).toBe(true);
        expect(await sut('build' as FilePath, false)).toBe(false);
      });
    });
  });

  describe('Given a deeply-nested path with a 3-level ancestor chain', () => {
    describe('When the predicate descends', () => {
      it('Then ancestors are computed with `/` separators (kills the "" mutant on joinPath)', async () => {
        // Arrange — `a/b/.gitignore` with `*.tmp` should match `a/b/foo.tmp`.
        // The predicate walks ancestors `["a", "a/b"]`; if the separator were
        // mutated to "" the ancestor would be `"ab"` and the nested rule
        // would never load.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/b/.gitignore`, '*.tmp\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const ignored = await sut('a/b/foo.tmp' as FilePath, false);

        // Assert
        expect(ignored).toBe(true);
      });
    });
  });

  describe('Given two sibling paths under the same ancestor', () => {
    describe('When the predicate is invoked for both', () => {
      it('Then the nested ruleset is loaded ONCE (no duplicate stack pushes)', async () => {
        // Arrange — `sub/.gitignore` with `*.tmp`. Calling the predicate twice
        // for sibling files in `sub/` must NOT re-push the nested level
        // (a `stackedDirs.has(ancestor) → false` mutant would re-load and
        // potentially shadow a future negation under the same basedir).
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '*.tmp\n');
        const baseReadUtf8 = ctx.fs.readUtf8;
        let nestedReads = 0;
        const countingFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readUtf8') {
              return async (p: string) => {
                if (p.endsWith('/sub/.gitignore')) nestedReads += 1;
                return baseReadUtf8(p);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const ctxWithSpy = { ...ctx, fs: countingFs };
        const sut = await buildRepoIgnorePredicate(ctxWithSpy);

        // Act
        await sut('sub/foo.tmp' as FilePath, false);
        await sut('sub/bar.tmp' as FilePath, false);

        // Assert — single load.
        expect(nestedReads).toBe(1);
      });
    });
  });

  describe('Given an info/exclude rule', () => {
    describe('When called for the matching path', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.txt\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act / Assert
        expect(await sut('secret.txt' as FilePath, false)).toBe(true);
      });
    });
  });

  describe('Given a path whose own directory-named segment is NOT an ancestor', () => {
    describe('When the predicate runs', () => {
      it('Then `.gitignore` files are looked up only for true ancestor directories (kills `i < length` → `i <= length`)', async () => {
        // Arrange — for path `a/foo.txt` the only ancestor is `a`. A mutant
        // that iterates `i <= segments.length` would also treat `a/foo.txt`
        // itself as an ancestor and look up `a/foo.txt/.gitignore`. The
        // lookup begins with `lstat` (and stops there when the file is
        // missing, so it never reaches `readUtf8`) — the spy must therefore
        // observe `lstat`/`lstatIfReachable` (the reader prefers the latter when the
        // adapter provides it), not `readUtf8`.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/.gitignore`, '*.x\n');
        const baseLstat = ctx.fs.lstat.bind(ctx.fs);
        const baseReachable = ctx.fs.lstatIfReachable?.bind(ctx.fs);
        const lstatGitignorePaths: string[] = [];
        const spyFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async (p: string) => {
                if (p.endsWith('/.gitignore')) lstatGitignorePaths.push(p);
                return baseLstat(p);
              };
            }
            if (prop === 'lstatIfReachable' && baseReachable !== undefined) {
              return async (p: string) => {
                if (p.endsWith('/.gitignore')) lstatGitignorePaths.push(p);
                return baseReachable(p);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const sut = await buildRepoIgnorePredicate({ ...ctx, fs: spyFs });

        // Act
        await sut('a/foo.txt' as FilePath, false);

        // Assert — exactly one nested `.gitignore` lookup (`a/.gitignore`);
        // never `a/foo.txt/.gitignore`. The `i <= length` mutant would add
        // a lookup for the path itself.
        const nested = lstatGitignorePaths.filter(
          (p) => !p.endsWith(`${ctx.layout.workDir}/.gitignore`),
        );
        expect(nested).toHaveLength(1);
        expect(nested[0]?.endsWith('/a/.gitignore')).toBe(true);
        expect(lstatGitignorePaths.some((p) => p.includes('foo.txt'))).toBe(false);
      });
    });
  });

  describe('Given a rule excluding the directory holding the path', () => {
    describe('When called for a file beneath the directory with root `ab`', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const result = await sut('ab/c' as FilePath, false);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When called for a file beneath the directory with root `ab/`', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab/\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const result = await sut('ab/c' as FilePath, false);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When called for a file beneath the directory with root `ab/` and a negation of the file', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab/\n!ab/c\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const result = await sut('ab/c' as FilePath, false);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When called for a file beneath the directory with root `ab/` and a nested negation', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab/\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/ab/.gitignore`, '!c\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const result = await sut('ab/c' as FilePath, false);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the nested rule file beneath the directory is oversized', () => {
      it('Then returns true without reading it', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab/\n');
        await ctx.fs.write(
          `${ctx.layout.workDir}/ab/.gitignore`,
          new Uint8Array(MAX_GITIGNORE_BYTES + 1).fill(0x23),
        );
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const result = await sut('ab/c' as FilePath, false);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the file is asked before its directory with a nested negation', () => {
      it('Then both are ignored', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab/\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/ab/.gitignore`, '!c\n');
        const sut = await buildRepoIgnorePredicate(ctx);

        // Act
        const file = await sut('ab/c' as FilePath, false);
        const directory = await sut('ab' as FilePath, true);

        // Assert
        expect(file).toBe(true);
        expect(directory).toBe(true);
      });
    });
  });
});

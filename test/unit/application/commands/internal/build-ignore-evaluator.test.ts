import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  buildIgnoreEvaluator,
  buildRepoIgnorePredicate,
} from '../../../../../src/application/commands/internal/build-ignore-evaluator.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/commands/internal/config-read.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

afterEach(() => __resetConfigCacheForTests());

const seed = async (homeDir?: string) => {
  const ctx = homeDir === undefined ? createMemoryContext() : createMemoryContext({ homeDir });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('buildIgnoreEvaluator', () => {
  it('Given no ignore sources, When built, Then base is empty', async () => {
    const ctx = await seed();

    const sut = await buildIgnoreEvaluator(ctx);

    expect(sut.base).toEqual([]);
  });

  it('Given root .gitignore + info/exclude + global, When built, Then base contains all three in order with basedir="" for each', async () => {
    // Arrange
    const ctx = await seed('/repo/home');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, '*.tmp\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  excludesFile = ~/global\n');
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

  it('Given the evaluator, When loadDirRules is invoked for the same directory twice, Then the second call returns the cached ruleset (same value, no second read)', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '*.tmp\n');
    const baseReadUtf8 = ctx.fs.readUtf8;
    let calls = 0;
    const countingFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'readUtf8') {
          return async (p: string) => {
            if (p.endsWith('/sub/.gitignore')) calls += 1;
            return baseReadUtf8(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const evalCtx = { ...ctx, fs: countingFs };
    const ev = await buildIgnoreEvaluator(evalCtx);

    // Act
    const first = await ev.loadDirRules('sub' as FilePath);
    const second = await ev.loadDirRules('sub' as FilePath);

    // Assert — only one read on the .gitignore AND both calls return
    // the same parsed ruleset (a mutant that returned an empty array
    // on the second call would have `calls === 1` but `second !== first`).
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
    expect(second[0]?.pattern).toBe('*.tmp');
  });
});

describe('buildRepoIgnorePredicate', () => {
  it('Given no ignore sources, When called, Then returns false for any path', async () => {
    const ctx = await seed();
    const sut = await buildRepoIgnorePredicate(ctx);

    expect(await sut('foo.txt' as FilePath, false)).toBe(false);
    expect(await sut('sub' as FilePath, true)).toBe(false);
  });

  it('Given a root .gitignore with `*.log`, When called for `foo.log`, Then returns true', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
    const sut = await buildRepoIgnorePredicate(ctx);

    // Act / Assert
    expect(await sut('foo.log' as FilePath, false)).toBe(true);
  });

  it('Given a root `*.log` ignore + a nested `!keep.log` re-include, When called for `sub/keep.log`, Then returns false (negation wins)', async () => {
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

  it('Given the same root + nested rules, When called for `sub/other.log`, Then returns true (only `keep.log` was re-included)', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '!keep.log\n');
    const sut = await buildRepoIgnorePredicate(ctx);

    // Act / Assert
    expect(await sut('sub/other.log' as FilePath, false)).toBe(true);
  });

  it('Given a directory-only rule `build/`, When called with isDirectory=true, Then returns true; with false returns false', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');
    const sut = await buildRepoIgnorePredicate(ctx);

    // Act / Assert
    expect(await sut('build' as FilePath, true)).toBe(true);
    expect(await sut('build' as FilePath, false)).toBe(false);
  });

  it('Given a deeply-nested path with a 3-level ancestor chain, When the predicate descends, Then ancestors are computed with `/` separators (kills the "" mutant on joinPath)', async () => {
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

  it('Given two sibling paths under the same ancestor, When the predicate is invoked for both, Then the nested ruleset is loaded ONCE (no duplicate stack pushes)', async () => {
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

  it('Given an info/exclude rule, When called for the matching path, Then returns true', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.txt\n');
    const sut = await buildRepoIgnorePredicate(ctx);

    // Act / Assert
    expect(await sut('secret.txt' as FilePath, false)).toBe(true);
  });

  it('Given a path whose own directory-named segment is NOT an ancestor, When the predicate runs, Then `.gitignore` files are looked up only for true ancestor directories (kills `i < length` → `i <= length`)', async () => {
    // Arrange — for path `a/foo.txt` the only ancestor is `a`. A mutant
    // that iterates `i <= segments.length` would also treat `a/foo.txt`
    // itself as an ancestor and look up `a/foo.txt/.gitignore`. The
    // lookup begins with `lstat` (and stops there when the file is
    // missing, so it never reaches `readUtf8`) — the spy must therefore
    // observe `lstat`, not `readUtf8`.
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/.gitignore`, '*.x\n');
    const baseLstat = ctx.fs.lstat.bind(ctx.fs);
    const lstatGitignorePaths: string[] = [];
    const spyFs = new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop === 'lstat') {
          return async (p: string) => {
            if (p.endsWith('/.gitignore')) lstatGitignorePaths.push(p);
            return baseLstat(p);
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

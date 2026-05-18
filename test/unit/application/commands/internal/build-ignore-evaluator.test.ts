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

  it('Given root .gitignore + info/exclude + global, When built, Then base contains all three in order', async () => {
    // Arrange
    const ctx = await seed('/repo/home');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, '*.tmp\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  excludesFile = ~/global\n');
    await ctx.fs.writeUtf8('/repo/home/global', '*.swp\n');

    // Act
    const sut = await buildIgnoreEvaluator(ctx);

    // Assert — order is global → info → root.
    expect(sut.base).toHaveLength(3);
    expect(sut.base[0]?.rules[0]?.pattern).toBe('*.swp');
    expect(sut.base[1]?.rules[0]?.pattern).toBe('*.tmp');
    expect(sut.base[2]?.rules[0]?.pattern).toBe('*.log');
  });

  it('Given the evaluator, When loadDirRules is invoked for the same directory twice, Then the second call returns the cached ruleset (no second read)', async () => {
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
    await ev.loadDirRules('sub' as FilePath);
    await ev.loadDirRules('sub' as FilePath);

    // Assert — only one read on the .gitignore.
    expect(calls).toBe(1);
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

  it('Given an info/exclude rule, When called for the matching path, Then returns true', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.txt\n');
    const sut = await buildRepoIgnorePredicate(ctx);

    // Act / Assert
    expect(await sut('secret.txt' as FilePath, false)).toBe(true);
  });
});

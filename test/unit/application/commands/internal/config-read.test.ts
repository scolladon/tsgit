import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  readConfig,
} from '../../../../../src/application/commands/internal/config-read.js';
import type { Context } from '../../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.config.gitDir}/config`, content);
};

describe('internal/config-read', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  it('Given missing .git/config, When readConfig, Then returns empty parsed config', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut).toEqual({});
  });

  it('Given a config with [core] bare=true, When readConfig, Then parsed.core.bare is true', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a config with [core] bare=false, When readConfig, Then parsed.core.bare is false', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\nbare = false\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(false);
  });

  it('Given a config with [core] bare=invalid (unparseable boolean), When readConfig, Then defaults to false', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\nbare = nope\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(false);
  });

  it('Given a config with [user] name and email, When readConfig, Then parsed.user is populated', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[user]\n  name = Ada Lovelace\n  email = ada@example.com\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.user?.name).toBe('Ada Lovelace');
    expect(sut.user?.email).toBe('ada@example.com');
  });

  it('Given a config with [user] name only, When readConfig, Then parsed.user is undefined (both fields required)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[user]\n  name = Solo\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.user).toBeUndefined();
  });

  it('Given a [remote "origin"] section with url, When readConfig, Then parsed.remote.get("origin")?.url is set', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "origin"]\n  url = https://example.com/r.git\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('origin')?.url).toBe('https://example.com/r.git');
  });

  it('Given a [remote "origin"] section with multiple fetch lines, When readConfig, Then all fetch refspecs are collected in order', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(
      ctx,
      '[remote "origin"]\n  url = https://example.com/r.git\n  fetch = +refs/heads/*:refs/remotes/origin/*\n  fetch = +refs/tags/*:refs/tags/*\n',
    );

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('origin')?.fetch).toEqual([
      '+refs/heads/*:refs/remotes/origin/*',
      '+refs/tags/*:refs/tags/*',
    ]);
  });

  it('Given a [branch "main"] section with remote and merge, When readConfig, Then parsed.branch.get("main") populated', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.branch?.get('main')?.remote).toBe('origin');
    expect(sut.branch?.get('main')?.merge).toBe('refs/heads/main');
  });

  it('Given a config with # comments and ; comments, When readConfig, Then comments are skipped', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(
      ctx,
      '# top comment\n; another comment\n[core]\n  bare = true # trailing\n  ; another\n',
    );

    // Act
    const sut = await readConfig(ctx);

    // Assert — comments do not leak into values; bare is still parsed.
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a config with a malformed line outside any section, When readConfig, Then the line is ignored (lenient parser)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, 'orphan = value\n[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a config with continuation (line ending in backslash), When readConfig, Then the next line is concatenated', async () => {
    // Arrange — Git supports backslash line continuation.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "origin"]\n  url = https://example.com/\\\n    really-long.git\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('origin')?.url).toBe('https://example.com/really-long.git');
  });

  it('Given a config with section names containing dot (e.g. core.subsection), When readConfig, Then unknown sections are ignored', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[unknown]\n  key = value\n[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given two consecutive readConfig calls, When called, Then second hits cache (fs.readUtf8 invoked once)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');
    const spy = vi.spyOn(ctx.fs, 'readUtf8');

    // Act
    await readConfig(ctx);
    await readConfig(ctx);

    // Assert — only one underlying read.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Given a config that was missing on first call, When readConfig is called twice, Then second call also hits cache', async () => {
    // Arrange — even an empty parsed config is cached so we don't re-stat per call.
    const ctx = createMemoryContext();
    const spy = vi.spyOn(ctx.fs, 'readUtf8');

    // Act
    await readConfig(ctx);
    await readConfig(ctx);

    // Assert
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Given a config with [user] containing whitespace + tabs, When readConfig, Then values are trimmed', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[user]\n\tname\t=\tBob\t\n\temail\t=\tbob@x.com\t\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.user?.name).toBe('Bob');
    expect(sut.user?.email).toBe('bob@x.com');
  });

  it('Given a config with bare=yes (truthy alias), When readConfig, Then parsed.core.bare is true', async () => {
    // Arrange — Git accepts yes/on/1 as true and no/off/0 as false.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\nbare = yes\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a config with bare=no, When readConfig, Then parsed.core.bare is false', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\nbare = no\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(false);
  });

  it('Given a [remote] section without subsection (no quotes), When readConfig, Then it is ignored', async () => {
    // Arrange — `[remote]` without a name is meaningless.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote]\n  url = https://example.com/r.git\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote).toBeUndefined();
  });

  it('Given two [remote "origin"] sections, When readConfig, Then later url overrides earlier and fetch lines accumulate across sections', async () => {
    // Arrange — accumulator semantics across multiple sections of the same name.
    const ctx = createMemoryContext();
    await seed(
      ctx,
      '[remote "origin"]\n  url = https://first.example/r.git\n  fetch = +a:b\n[remote "origin"]\n  url = https://second.example/r.git\n  fetch = +c:d\n',
    );

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('origin')?.url).toBe('https://second.example/r.git');
    expect(sut.remote?.get('origin')?.fetch).toEqual(['+a:b', '+c:d']);
  });

  it('Given two [branch "main"] sections, When readConfig, Then later values win', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(
      ctx,
      '[branch "main"]\n  remote = a\n  merge = refs/heads/x\n[branch "main"]\n  remote = b\n  merge = refs/heads/y\n',
    );

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.branch?.get('main')?.remote).toBe('b');
    expect(sut.branch?.get('main')?.merge).toBe('refs/heads/y');
  });

  it('Given a [remote "X"] without url but with fetch, When readConfig, Then the entry is present with only fetch (no url)', async () => {
    // Arrange — accumulator must not synthesize a url when none is given.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "x"]\n  fetch = +a:b\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('x')?.url).toBeUndefined();
    expect(sut.remote?.get('x')?.fetch).toEqual(['+a:b']);
  });

  it('Given a [user] with email only, When readConfig, Then user is undefined (both required)', async () => {
    // Arrange — finalize() requires both name AND email; either alone collapses.
    const ctx = createMemoryContext();
    await seed(ctx, '[user]\n  email = ada@example.com\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.user).toBeUndefined();
  });

  it('Given a section header without closing bracket, When readConfig, Then the malformed line is ignored', async () => {
    const ctx = createMemoryContext();
    await seed(ctx, '[core\n  bare = true\n[user]\n  name = X\n  email = x@y.com\n');
    const sut = await readConfig(ctx);
    expect(sut.core?.bare).toBeUndefined();
    expect(sut.user?.name).toBe('X');
  });

  it('Given an inline comment after a value, When readConfig, Then the comment is stripped from the value', async () => {
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "origin"]\n  url = https://example.com/r.git # trailing\n');
    const sut = await readConfig(ctx);
    expect(sut.remote?.get('origin')?.url).toBe('https://example.com/r.git');
  });

  it('Given a value containing a quoted `#`, When readConfig, Then the `#` inside the quotes is preserved', async () => {
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "origin"]\n  url = "https://example.com/r#frag.git"\n');
    const sut = await readConfig(ctx);
    expect(sut.remote?.get('origin')?.url).toContain('#frag');
  });
});

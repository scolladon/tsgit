import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  readConfig,
} from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('primitives/config-read', () => {
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

  it('Given [core] logallrefupdates=true, When readConfig, Then logAllRefUpdates is true', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  logallrefupdates = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.logAllRefUpdates).toBe(true);
  });

  it('Given [core] logallrefupdates=false, When readConfig, Then logAllRefUpdates is false', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  logallrefupdates = false\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.logAllRefUpdates).toBe(false);
  });

  it("Given [core] logallrefupdates=always, When readConfig, Then logAllRefUpdates is 'always'", async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  logallrefupdates = always\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.logAllRefUpdates).toBe('always');
  });

  it('Given [core] logallrefupdates=ALWAYS (mixed case), When readConfig, Then matching is case-insensitive', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  logallrefupdates = ALWAYS\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.logAllRefUpdates).toBe('always');
  });

  it('Given a config without logallrefupdates, When readConfig, Then core has no logAllRefUpdates key', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — strict shape: no `logAllRefUpdates` key is emitted at all,
    // not even as an explicit `undefined`.
    expect(sut.core).toStrictEqual({ bare: true });
  });

  it('Given an unrecognised [core] key, When readConfig, Then it does not become logAllRefUpdates', async () => {
    // Arrange — only `bare`/`excludesfile`/`logallrefupdates` are consumed;
    // `autocrlf` is a real git key tsgit ignores.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  autocrlf = always\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core).toBeUndefined();
  });

  it('Given only logallrefupdates in [core], When readConfig, Then core is emitted with that field', async () => {
    // Arrange — guards the finalize() arm that now also checks logAllRefUpdates.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  logallrefupdates = always\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core).toEqual({ logAllRefUpdates: 'always' });
  });

  it('Given [core] hooksPath set, When readConfig, Then parsed.core.hooksPath carries the value', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  hooksPath = /opt/githooks\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.hooksPath).toBe('/opt/githooks');
  });

  it('Given [core] HooksPath in mixed case, When readConfig, Then the key match is case-insensitive', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  HooksPath = .husky\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.hooksPath).toBe('.husky');
  });

  it('Given only hooksPath in [core], When readConfig, Then core is emitted with that field', async () => {
    // Arrange — guards the finalize() arm that now also checks hooksPath.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  hooksPath = /opt/githooks\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core).toEqual({ hooksPath: '/opt/githooks' });
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

  it('Given a cached config and an explicit cache reset on the same context, When readConfig is called again, Then the file is re-read', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');
    const spy = vi.spyOn(ctx.fs, 'readUtf8');

    // Act
    await readConfig(ctx);
    __resetConfigCacheForTests();
    await readConfig(ctx);

    // Assert — reset replaces the WeakMap, so the second call misses the cache.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('Given fs.readUtf8 rejects with a non-TsgitError, When readConfig, Then the error is rethrown', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const boom = new Error('disk on fire');
    vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(boom);

    // Act
    let caught: unknown;
    try {
      await readConfig(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBe(boom);
  });

  it('Given fs.readUtf8 rejects with a TsgitError that is not FILE_NOT_FOUND, When readConfig, Then the error is rethrown', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: '/x/config' });
    vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(denied);

    // Act
    let caught: unknown;
    try {
      await readConfig(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert — only FILE_NOT_FOUND is swallowed; other codes propagate.
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data).toEqual({ code: 'PERMISSION_DENIED', path: '/x/config' });
  });

  it('Given a section header line preceded by leading whitespace, When readConfig, Then the header is recognized after trimming', async () => {
    // Arrange — stripInlineComment(line) must be trimmed before header parsing.
    const ctx = createMemoryContext();
    await seed(ctx, '  [core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a continuation line with no leading whitespace but internal spaces, When readConfig, Then only leading whitespace would be stripped (internal spaces kept)', async () => {
    // Arrange — continuation join uses /^\s+/, so internal spaces survive.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "origin"]\n  url = ab\\\ncd ef.git\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('origin')?.url).toBe('abcd ef.git');
  });

  it('Given a config whose final line ends with a backslash continuation, When readConfig, Then the leftover pending content is still flushed', async () => {
    // Arrange — no trailing newline; the last physical line ends with `\`.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\\');

    // Act
    const sut = await readConfig(ctx);

    // Assert — pending must be pushed at EOF or `bare` is lost.
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a `;` inline comment after a value, When readConfig, Then the comment is stripped from the value', async () => {
    // Arrange — indexOfUnquoted must search for `;` as well as `#`.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true ; trailing semicolon comment\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a value with both `#` and `;` inline comments, When readConfig, Then the value is cut at the earliest comment marker', async () => {
    // Arrange — `#` appears before `;`; Math.min picks the `#` position.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true # hash ; semi\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — cutting at `;` instead would leave `true # hash` (unparseable → false).
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a header missing `[` but ending with `]`, When readConfig, Then it is rejected', async () => {
    // Arrange — `.core]` ends with `]`; only the missing `[` should reject it.
    const ctx = createMemoryContext();
    await seed(ctx, '.core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core).toBeUndefined();
  });

  it('Given a header starting with `[` but missing `]`, When readConfig, Then it is rejected', async () => {
    // Arrange — `[core.` starts with `[`; only the missing `]` should reject it.
    const ctx = createMemoryContext();
    await seed(ctx, '[core.\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core).toBeUndefined();
  });

  it('Given a header with neither bracket where one is required, When readConfig, Then it is rejected (both brackets needed)', async () => {
    // Arrange — `[core)` has `[` but `)` not `]`; the `||` guard must reject it.
    const ctx = createMemoryContext();
    await seed(ctx, '[core)\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core).toBeUndefined();
  });

  it('Given a `[remote "..."]` header with an unterminated subsection quote, When readConfig, Then the section is rejected', async () => {
    // Arrange — only one `"`: lastQuote === quoteAt, so the header is malformed.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "origin]\n  url = https://example.com/r.git\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote).toBeUndefined();
  });

  it('Given a `[core]` body line that contains no `=`, When readConfig, Then the line is ignored entirely', async () => {
    // Arrange — `bareX` has no `=`; parseKeyValue must reject it outright.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bareX\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — accepting it would synthesize a `bare` key and define `core`.
    expect(sut.core).toBeUndefined();
  });

  it('Given a `[core "sub"]` section before a plain `[core]`, When readConfig, Then the subsectioned core is ignored', async () => {
    // Arrange — core with a subsection must NOT be treated as `[core]`.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = false\n[core "weird"]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — `[core "weird"]` is ignored, so `bare` stays false.
    expect(sut.core?.bare).toBe(false);
  });

  it('Given a non-user section without a subsection carrying name/email keys, When readConfig, Then it is not parsed as `[user]`', async () => {
    // Arrange — `[foo]` must not satisfy the `[user]` branch.
    const ctx = createMemoryContext();
    await seed(ctx, '[foo]\n  name = X\n  email = e@x.com\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.user).toBeUndefined();
  });

  it('Given a `[user "sub"]` section with name and email, When readConfig, Then the subsectioned user is ignored', async () => {
    // Arrange — user with a subsection must NOT be treated as `[user]`.
    const ctx = createMemoryContext();
    await seed(ctx, '[user "sub"]\n  name = X\n  email = e@x.com\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.user).toBeUndefined();
  });

  it('Given a non-branch subsectionless section with branch-like keys, When readConfig, Then it is not parsed as `[branch]`', async () => {
    // Arrange — `[foo]` must not satisfy the `[branch]` branch.
    const ctx = createMemoryContext();
    await seed(ctx, '[foo]\n  remote = origin\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.branch).toBeUndefined();
  });

  it('Given a `[user]` section with name and an unrecognized key, When readConfig, Then the unrecognized key is not treated as email', async () => {
    // Arrange — only the literal key `email` may populate user.email.
    const ctx = createMemoryContext();
    await seed(ctx, '[user]\n  name = N\n  bogus = B\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — user needs both name AND email; `bogus` must not stand in for email.
    expect(sut.user).toBeUndefined();
  });

  it('Given a `[remote]` section with url and an unrecognized key, When readConfig, Then the unrecognized key is not treated as fetch', async () => {
    // Arrange — only the literal key `fetch` may append to remote.fetch.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "o"]\n  url = u\n  bogus = B\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('o')?.fetch).toBeUndefined();
  });

  it('Given a `[remote]` section with a url but no fetch lines, When readConfig, Then fetch stays absent (not an empty array)', async () => {
    // Arrange — finalize must not synthesize an empty fetch array.
    const ctx = createMemoryContext();
    await seed(ctx, '[remote "o"]\n  url = u\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.remote?.get('o')?.fetch).toBeUndefined();
  });

  it('Given two `[branch "main"]` sections each setting a different single key, When readConfig, Then both keys accumulate', async () => {
    // Arrange — the second section must merge onto the first, not replace it.
    const ctx = createMemoryContext();
    await seed(ctx, '[branch "main"]\n  remote = a\n[branch "main"]\n  merge = m\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — `remote` from the first section must survive the second merge.
    expect(sut.branch?.get('main')?.remote).toBe('a');
    expect(sut.branch?.get('main')?.merge).toBe('m');
  });

  it('Given a `[branch]` section with remote and an unrecognized key, When readConfig, Then the unrecognized key is not treated as merge', async () => {
    // Arrange — only the literal key `merge` may populate branch.merge.
    const ctx = createMemoryContext();
    await seed(ctx, '[branch "main"]\n  remote = origin\n  bogus = B\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.branch?.get('main')?.merge).toBeUndefined();
  });

  it('Given a config with no `[core]` section, When readConfig, Then `core` is absent from the result', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[user]\n  name = N\n  email = e@x.com\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — `core` key must not be present at all.
    expect('core' in sut).toBe(false);
  });

  it('Given a `[core]` section with only excludesFile, When readConfig, Then `bare` is absent from core', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  excludesfile = /etc/gitignore\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — no `bare` key when bare was never configured.
    expect(sut.core?.excludesFile).toBe('/etc/gitignore');
    expect('bare' in (sut.core ?? {})).toBe(false);
  });

  it('Given a `[core]` section with only bare, When readConfig, Then `excludesFile` is absent from core', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — no `excludesFile` key when it was never configured.
    expect(sut.core?.bare).toBe(true);
    expect('excludesFile' in (sut.core ?? {})).toBe(false);
  });

  it('Given a config with no `[remote]` section, When readConfig, Then `remote` is absent from the result', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect('remote' in sut).toBe(false);
  });

  it('Given a config with no `[branch]` section, When readConfig, Then `branch` is absent from the result', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect('branch' in sut).toBe(false);
  });

  it('Given a section header with whitespace inside the brackets (`[ core ]`), When readConfig, Then the inner name is trimmed and the section is recognized', async () => {
    // Arrange — `slice(1, -1)` yields ` core `; only the `.trim()` makes it
    // equal `core`. Dropping `.trim()` leaves the section named ` core `,
    // which assembleParsed never matches, so `bare` would be lost.
    const ctx = createMemoryContext();
    await seed(ctx, '[ core ]\n  bare = true\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given a `[foo "bar"]` section (subsectioned, not branch) carrying remote/merge keys, When readConfig, Then it is NOT parsed as `[branch]`', async () => {
    // Arrange — `[foo "bar"]` has a subsection but section name `foo`.
    // Forcing the `sec.section === 'branch'` operand to `true` would make
    // any subsectioned section populate `branch`.
    const ctx = createMemoryContext();
    await seed(ctx, '[foo "bar"]\n  remote = origin\n  merge = refs/heads/x\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert — branch must stay absent; the `foo` section is unknown.
    expect(sut.branch).toBeUndefined();
  });

  it('Given `bare = on` (truthy alias), When readConfig, Then parsed.core.bare is true', async () => {
    // Arrange — `on`/`1` are git truthy aliases.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = on\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(true);
  });

  it('Given `bare = off` (explicit false alias), When readConfig, Then parsed.core.bare is false', async () => {
    // Arrange — `off`/`0` are git falsy aliases; not truthy.
    const ctx = createMemoryContext();
    await seed(ctx, '[core]\n  bare = off\n');

    // Act
    const sut = await readConfig(ctx);

    // Assert
    expect(sut.core?.bare).toBe(false);
  });
});

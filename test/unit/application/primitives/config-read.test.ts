import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  type IniSection,
  invalidateConfigCache,
  parseIniSections,
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

  describe('Given missing .git/config', () => {
    describe('When readConfig', () => {
      it('Then returns empty parsed config', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut).toEqual({});
      });
    });
  });

  describe('Given a config with [core] bare=true', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.bare is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a config with [core] bare=false', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.bare is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(false);
      });
    });
  });

  describe('Given a config with [core] bare=invalid (unparseable boolean)', () => {
    describe('When readConfig', () => {
      it('Then defaults to false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare = nope\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(false);
      });
    });
  });

  describe('Given [core] logallrefupdates=true', () => {
    describe('When readConfig', () => {
      it('Then logAllRefUpdates is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  logallrefupdates = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.logAllRefUpdates).toBe(true);
      });
    });
  });

  describe('Given [core] logallrefupdates=false', () => {
    describe('When readConfig', () => {
      it('Then logAllRefUpdates is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  logallrefupdates = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.logAllRefUpdates).toBe(false);
      });
    });
  });

  describe('Given [core] logallrefupdates=always', () => {
    describe('When readConfig', () => {
      it("Then logAllRefUpdates is 'always'", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  logallrefupdates = always\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.logAllRefUpdates).toBe('always');
      });
    });
  });

  describe('Given [core] logallrefupdates=ALWAYS (mixed case)', () => {
    describe('When readConfig', () => {
      it('Then matching is case-insensitive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  logallrefupdates = ALWAYS\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.logAllRefUpdates).toBe('always');
      });
    });
  });

  describe('Given a config without logallrefupdates', () => {
    describe('When readConfig', () => {
      it('Then core has no logAllRefUpdates key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — strict shape: no `logAllRefUpdates` key is emitted at all,
        // not even as an explicit `undefined`.
        expect(sut.core).toStrictEqual({ bare: true });
      });
    });
  });

  describe('Given an unrecognised [core] key', () => {
    describe('When readConfig', () => {
      it('Then it does not become logAllRefUpdates', async () => {
        // Arrange — only `bare`/`excludesfile`/`logallrefupdates` are consumed;
        // `autocrlf` is a real git key tsgit ignores.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  autocrlf = always\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toBeUndefined();
      });
    });
  });

  describe('Given only logallrefupdates in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with that field', async () => {
        // Arrange — guards the finalize() arm that now also checks logAllRefUpdates.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  logallrefupdates = always\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toEqual({ logAllRefUpdates: 'always' });
      });
    });
  });

  describe('Given [core] hooksPath set', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.hooksPath carries the value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  hooksPath = /opt/githooks\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.hooksPath).toBe('/opt/githooks');
      });
    });
  });

  describe('Given [core] HooksPath in mixed case', () => {
    describe('When readConfig', () => {
      it('Then the key match is case-insensitive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  HooksPath = .husky\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.hooksPath).toBe('.husky');
      });
    });
  });

  describe('Given only hooksPath in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with that field', async () => {
        // Arrange — guards the finalize() arm that now also checks hooksPath.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  hooksPath = /opt/githooks\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toEqual({ hooksPath: '/opt/githooks' });
      });
    });
  });

  describe('Given a config with [user] name and email', () => {
    describe('When readConfig', () => {
      it('Then parsed.user is populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = Ada Lovelace\n  email = ada@example.com\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.user?.name).toBe('Ada Lovelace');
        expect(sut.user?.email).toBe('ada@example.com');
      });
    });
  });

  describe('Given a config with [user] name only', () => {
    describe('When readConfig', () => {
      it('Then parsed.user is undefined (both fields required)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = Solo\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.user).toBeUndefined();
      });
    });
  });

  describe('Given a [remote "origin"] section with url', () => {
    describe('When readConfig', () => {
      it('Then parsed.remote.get("origin")?.url is set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/r.git\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('origin')?.url).toBe('https://example.com/r.git');
      });
    });
  });

  describe('Given a [remote "origin"] section with multiple fetch lines', () => {
    describe('When readConfig', () => {
      it('Then all fetch refspecs are collected in order', async () => {
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
    });
  });

  describe('Given a [branch "main"] section with remote and merge', () => {
    describe('When readConfig', () => {
      it('Then parsed.branch.get("main") populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = origin\n  merge = refs/heads/main\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.branch?.get('main')?.remote).toBe('origin');
        expect(sut.branch?.get('main')?.merge).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a config with # comments and ; comments', () => {
    describe('When readConfig', () => {
      it('Then comments are skipped', async () => {
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
    });
  });

  describe('Given a config with a malformed line outside any section', () => {
    describe('When readConfig', () => {
      it('Then the line is ignored (lenient parser)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'orphan = value\n[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a config with continuation (line ending in backslash)', () => {
    describe('When readConfig', () => {
      it('Then the next line is concatenated', async () => {
        // Arrange — Git supports backslash line continuation.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/\\\n    really-long.git\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('origin')?.url).toBe('https://example.com/really-long.git');
      });
    });
  });

  describe('Given a config with section names containing dot (e.g. core.subsection)', () => {
    describe('When readConfig', () => {
      it('Then unknown sections are ignored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[unknown]\n  key = value\n[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given two consecutive readConfig calls', () => {
    describe('When called', () => {
      it('Then second hits cache (fs.readUtf8 invoked once)', async () => {
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
    });
  });

  describe('Given a config that was missing on first call', () => {
    describe('When readConfig is called twice', () => {
      it('Then second call also hits cache', async () => {
        // Arrange — even an empty parsed config is cached so we don't re-stat per call.
        const ctx = createMemoryContext();
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        await readConfig(ctx);

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a config with [user] containing whitespace + tabs', () => {
    describe('When readConfig', () => {
      it('Then values are trimmed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n\tname\t=\tBob\t\n\temail\t=\tbob@x.com\t\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.user?.name).toBe('Bob');
        expect(sut.user?.email).toBe('bob@x.com');
      });
    });
  });

  describe('Given a config with bare=yes (truthy alias)', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.bare is true', async () => {
        // Arrange — Git accepts yes/on/1 as true and no/off/0 as false.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare = yes\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a config with bare=no', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.bare is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare = no\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(false);
      });
    });
  });

  describe('Given a [remote] section without subsection (no quotes)', () => {
    describe('When readConfig', () => {
      it('Then it is ignored', async () => {
        // Arrange — `[remote]` without a name is meaningless.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote]\n  url = https://example.com/r.git\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote).toBeUndefined();
      });
    });
  });

  describe('Given two [remote "origin"] sections', () => {
    describe('When readConfig', () => {
      it('Then later url overrides earlier and fetch lines accumulate across sections', async () => {
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
    });
  });

  describe('Given two [branch "main"] sections', () => {
    describe('When readConfig', () => {
      it('Then later values win', async () => {
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
    });
  });

  describe('Given a [remote "X"] without url but with fetch', () => {
    describe('When readConfig', () => {
      it('Then the entry is present with only fetch (no url)', async () => {
        // Arrange — accumulator must not synthesize a url when none is given.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "x"]\n  fetch = +a:b\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('x')?.url).toBeUndefined();
        expect(sut.remote?.get('x')?.fetch).toEqual(['+a:b']);
      });
    });
  });

  describe('Given a [user] with email only', () => {
    describe('When readConfig', () => {
      it('Then user is undefined (both required)', async () => {
        // Arrange — finalize() requires both name AND email; either alone collapses.
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  email = ada@example.com\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.user).toBeUndefined();
      });
    });
  });

  describe('Given a section header without closing bracket', () => {
    describe('When readConfig', () => {
      it('Then the malformed line is ignored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core\n  bare = true\n[user]\n  name = X\n  email = x@y.com\n');
        const sut = await readConfig(ctx);
        // Assert
        expect(sut.core?.bare).toBeUndefined();
        expect(sut.user?.name).toBe('X');
      });
    });
  });

  describe('Given an inline comment after a value', () => {
    describe('When readConfig', () => {
      it('Then the comment is stripped from the value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/r.git # trailing\n');
        const sut = await readConfig(ctx);
        // Assert
        expect(sut.remote?.get('origin')?.url).toBe('https://example.com/r.git');
      });
    });
  });

  describe('Given a value containing a quoted `#`', () => {
    describe('When readConfig', () => {
      it('Then the `#` inside the quotes is preserved', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = "https://example.com/r#frag.git"\n');
        const sut = await readConfig(ctx);
        // Assert
        expect(sut.remote?.get('origin')?.url).toContain('#frag');
      });
    });
  });

  describe('Given a cached config and an explicit cache reset on the same context', () => {
    describe('When readConfig is called again', () => {
      it('Then the file is re-read', async () => {
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
    });
  });

  describe('Given fs.readUtf8 rejects with a non-TsgitError', () => {
    describe('When readConfig', () => {
      it('Then the error is rethrown', async () => {
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
    });
  });

  describe('Given fs.readUtf8 rejects with a TsgitError that is not FILE_NOT_FOUND', () => {
    describe('When readConfig', () => {
      it('Then the error is rethrown', async () => {
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
        expect((caught as TsgitError).data).toEqual({
          code: 'PERMISSION_DENIED',
          path: '/x/config',
        });
      });
    });
  });

  describe('Given a section header line preceded by leading whitespace', () => {
    describe('When readConfig', () => {
      it('Then the header is recognized after trimming', async () => {
        // Arrange — stripInlineComment(line) must be trimmed before header parsing.
        const ctx = createMemoryContext();
        await seed(ctx, '  [core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a continuation line with no leading whitespace but internal spaces', () => {
    describe('When readConfig', () => {
      it('Then only leading whitespace would be stripped (internal spaces kept)', async () => {
        // Arrange — continuation join uses /^\s+/, so internal spaces survive.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = ab\\\ncd ef.git\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('origin')?.url).toBe('abcd ef.git');
      });
    });
  });

  describe('Given a config whose final line ends with a backslash continuation', () => {
    describe('When readConfig', () => {
      it('Then the leftover pending content is still flushed', async () => {
        // Arrange — no trailing newline; the last physical line ends with `\`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\\');

        // Act
        const sut = await readConfig(ctx);

        // Assert — pending must be pushed at EOF or `bare` is lost.
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a `;` inline comment after a value', () => {
    describe('When readConfig', () => {
      it('Then the comment is stripped from the value', async () => {
        // Arrange — indexOfUnquoted must search for `;` as well as `#`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true ; trailing semicolon comment\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a value with both `#` and `;` inline comments', () => {
    describe('When readConfig', () => {
      it('Then the value is cut at the earliest comment marker', async () => {
        // Arrange — `#` appears before `;`; Math.min picks the `#` position.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true # hash ; semi\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — cutting at `;` instead would leave `true # hash` (unparseable → false).
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given a header missing `[` but ending with `]`', () => {
    describe('When readConfig', () => {
      it('Then it is rejected', async () => {
        // Arrange — `.core]` ends with `]`; only the missing `[` should reject it.
        const ctx = createMemoryContext();
        await seed(ctx, '.core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toBeUndefined();
      });
    });
  });

  describe('Given a header starting with `[` but missing `]`', () => {
    describe('When readConfig', () => {
      it('Then it is rejected', async () => {
        // Arrange — `[core.` starts with `[`; only the missing `]` should reject it.
        const ctx = createMemoryContext();
        await seed(ctx, '[core.\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toBeUndefined();
      });
    });
  });

  describe('Given a header with neither bracket where one is required', () => {
    describe('When readConfig', () => {
      it('Then it is rejected (both brackets needed)', async () => {
        // Arrange — `[core)` has `[` but `)` not `]`; the `||` guard must reject it.
        const ctx = createMemoryContext();
        await seed(ctx, '[core)\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote "..."]` header with an unterminated subsection quote', () => {
    describe('When readConfig', () => {
      it('Then the section is rejected', async () => {
        // Arrange — only one `"`: lastQuote === quoteAt, so the header is malformed.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin]\n  url = https://example.com/r.git\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote).toBeUndefined();
      });
    });
  });

  describe('Given a `[core]` body line that contains no `=`', () => {
    describe('When readConfig', () => {
      it('Then the line is ignored entirely', async () => {
        // Arrange — `bareX` has no `=`; parseKeyValue must reject it outright.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bareX\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — accepting it would synthesize a `bare` key and define `core`.
        expect(sut.core).toBeUndefined();
      });
    });
  });

  describe('Given a `[core "sub"]` section before a plain `[core]`', () => {
    describe('When readConfig', () => {
      it('Then the subsectioned core is ignored', async () => {
        // Arrange — core with a subsection must NOT be treated as `[core]`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n[core "weird"]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — `[core "weird"]` is ignored, so `bare` stays false.
        expect(sut.core?.bare).toBe(false);
      });
    });
  });

  describe('Given a non-user section without a subsection carrying name/email keys', () => {
    describe('When readConfig', () => {
      it('Then it is not parsed as `[user]`', async () => {
        // Arrange — `[foo]` must not satisfy the `[user]` branch.
        const ctx = createMemoryContext();
        await seed(ctx, '[foo]\n  name = X\n  email = e@x.com\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.user).toBeUndefined();
      });
    });
  });

  describe('Given a `[user "sub"]` section with name and email', () => {
    describe('When readConfig', () => {
      it('Then the subsectioned user is ignored', async () => {
        // Arrange — user with a subsection must NOT be treated as `[user]`.
        const ctx = createMemoryContext();
        await seed(ctx, '[user "sub"]\n  name = X\n  email = e@x.com\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.user).toBeUndefined();
      });
    });
  });

  describe('Given a non-branch subsectionless section with branch-like keys', () => {
    describe('When readConfig', () => {
      it('Then it is not parsed as `[branch]`', async () => {
        // Arrange — `[foo]` must not satisfy the `[branch]` branch.
        const ctx = createMemoryContext();
        await seed(ctx, '[foo]\n  remote = origin\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.branch).toBeUndefined();
      });
    });
  });

  describe('Given a `[user]` section with name and an unrecognized key', () => {
    describe('When readConfig', () => {
      it('Then the unrecognized key is not treated as email', async () => {
        // Arrange — only the literal key `email` may populate user.email.
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = N\n  bogus = B\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — user needs both name AND email; `bogus` must not stand in for email.
        expect(sut.user).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote]` section with url and an unrecognized key', () => {
    describe('When readConfig', () => {
      it('Then the unrecognized key is not treated as fetch', async () => {
        // Arrange — only the literal key `fetch` may append to remote.fetch.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\n  url = u\n  bogus = B\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('o')?.fetch).toBeUndefined();
      });
    });
  });

  describe('Given a `[remote]` section with a url but no fetch lines', () => {
    describe('When readConfig', () => {
      it('Then fetch stays absent (not an empty array)', async () => {
        // Arrange — finalize must not synthesize an empty fetch array.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\n  url = u\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('o')?.fetch).toBeUndefined();
      });
    });
  });

  describe('Given two `[branch "main"]` sections each setting a different single key', () => {
    describe('When readConfig', () => {
      it('Then both keys accumulate', async () => {
        // Arrange — the second section must merge onto the first, not replace it.
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = a\n[branch "main"]\n  merge = m\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — `remote` from the first section must survive the second merge.
        expect(sut.branch?.get('main')?.remote).toBe('a');
        expect(sut.branch?.get('main')?.merge).toBe('m');
      });
    });
  });

  describe('Given a `[branch]` section with remote and an unrecognized key', () => {
    describe('When readConfig', () => {
      it('Then the unrecognized key is not treated as merge', async () => {
        // Arrange — only the literal key `merge` may populate branch.merge.
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "main"]\n  remote = origin\n  bogus = B\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.branch?.get('main')?.merge).toBeUndefined();
      });
    });
  });

  describe('Given a config with no `[core]` section', () => {
    describe('When readConfig', () => {
      it('Then `core` is absent from the result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n  name = N\n  email = e@x.com\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — `core` key must not be present at all.
        expect('core' in sut).toBe(false);
      });
    });
  });

  describe('Given a `[core]` section with only excludesFile', () => {
    describe('When readConfig', () => {
      it('Then `bare` is absent from core', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  excludesfile = /etc/gitignore\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — no `bare` key when bare was never configured.
        expect(sut.core?.excludesFile).toBe('/etc/gitignore');
        expect('bare' in (sut.core ?? {})).toBe(false);
      });
    });
  });

  describe('Given a `[core]` section with only bare', () => {
    describe('When readConfig', () => {
      it('Then `excludesFile` is absent from core', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — no `excludesFile` key when it was never configured.
        expect(sut.core?.bare).toBe(true);
        expect('excludesFile' in (sut.core ?? {})).toBe(false);
      });
    });
  });

  describe('Given a config with no `[remote]` section', () => {
    describe('When readConfig', () => {
      it('Then `remote` is absent from the result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect('remote' in sut).toBe(false);
      });
    });
  });

  describe('Given a config with no `[branch]` section', () => {
    describe('When readConfig', () => {
      it('Then `branch` is absent from the result', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect('branch' in sut).toBe(false);
      });
    });
  });

  describe('Given a section header with whitespace inside the brackets (`[ core ]`)', () => {
    describe('When readConfig', () => {
      it('Then the inner name is trimmed and the section is recognized', async () => {
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
    });
  });

  describe('Given a `[foo "bar"]` section (subsectioned, not branch) carrying remote/merge keys', () => {
    describe('When readConfig', () => {
      it('Then it is NOT parsed as `[branch]`', async () => {
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
    });
  });

  describe('Given `bare = on` (truthy alias)', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.bare is true', async () => {
        // Arrange — `on`/`1` are git truthy aliases.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = on\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(true);
      });
    });
  });

  describe('Given `bare = off` (explicit false alias)', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.bare is false', async () => {
        // Arrange — `off`/`0` are git falsy aliases; not truthy.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = off\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.bare).toBe(false);
      });
    });
  });

  describe('Given [core] sparseCheckout=true', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.sparseCheckout is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckout).toBe(true);
      });
    });
  });

  describe('Given [core] sparseCheckout=false', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.sparseCheckout is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckout).toBe(false);
      });
    });
  });

  describe('Given [core] SPARSECHECKOUT in upper case', () => {
    describe('When readConfig', () => {
      it('Then the key match is case-insensitive', async () => {
        // Arrange — git config keys are case-insensitive; the lowercased compare
        // in mergeCore must still match an upper-cased key.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  SPARSECHECKOUT = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckout).toBe(true);
      });
    });
  });

  describe('Given [core] sparseCheckout=yes (truthy alias)', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.sparseCheckout is true', async () => {
        // Arrange — parseGitBoolean accepts yes/on/1 as true.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = yes\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckout).toBe(true);
      });
    });
  });

  describe('Given [core] sparseCheckoutCone=true', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.sparseCheckoutCone is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckoutCone = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckoutCone).toBe(true);
      });
    });
  });

  describe('Given [core] sparseCheckoutCone=false', () => {
    describe('When readConfig', () => {
      it('Then parsed.core.sparseCheckoutCone is false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckoutCone = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckoutCone).toBe(false);
      });
    });
  });

  describe('Given [core] SparseCheckoutCone in mixed case', () => {
    describe('When readConfig', () => {
      it('Then the key match is case-insensitive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  SparseCheckoutCone = on\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core?.sparseCheckoutCone).toBe(true);
      });
    });
  });

  describe('Given only sparseCheckout in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with just that field', async () => {
        // Arrange — guards the finalizeCore arm for sparseCheckout: it must be the
        // sole key in the emitted object, with no sibling keys synthesized.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toEqual({ sparseCheckout: true });
      });
    });
  });

  describe('Given only sparseCheckoutCone in [core]', () => {
    describe('When readConfig', () => {
      it('Then core is emitted with just that field', async () => {
        // Arrange — guards the finalizeCore arm for sparseCheckoutCone in isolation.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckoutCone = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toEqual({ sparseCheckoutCone: true });
      });
    });
  });

  describe('Given a [core] with bare set but no sparse keys', () => {
    describe('When readConfig', () => {
      it('Then no sparse keys are emitted', async () => {
        // Arrange — the finalizeCore `!== undefined` arms must not synthesize the
        // sparse keys when they were never configured.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — strict shape: only `bare`, neither sparse key present.
        expect(sut.core).toStrictEqual({ bare: true });
      });
    });
  });

  describe('Given both sparseCheckout and sparseCheckoutCone set', () => {
    describe('When readConfig', () => {
      it('Then both round-trip independently', async () => {
        // Arrange — sparseCheckout=true, sparseCheckoutCone=false: distinct values
        // prove the two arms parse separate keys, not the same one.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  sparseCheckout = true\n  sparseCheckoutCone = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.core).toEqual({ sparseCheckout: true, sparseCheckoutCone: false });
      });
    });
  });

  describe('Given a cached config and invalidateConfigCache for that context', () => {
    describe('When readConfig is called again', () => {
      it('Then the file is re-read', async () => {
        // Arrange — the production per-context invalidator drops the stale entry.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = true\n');
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await readConfig(ctx);
        invalidateConfigCache(ctx);
        await readConfig(ctx);

        // Assert — the dropped entry forces a second underlying read.
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given invalidateConfigCache for one context', () => {
    describe('When another context reads', () => {
      it('Then the other context keeps its cache', async () => {
        // Arrange — invalidation is per-context: dropping ctxA must not evict ctxB.
        const ctxA = createMemoryContext();
        const ctxB = createMemoryContext();
        await seed(ctxA, '[core]\n  bare = true\n');
        await seed(ctxB, '[core]\n  bare = true\n');
        const spyB = vi.spyOn(ctxB.fs, 'readUtf8');

        // Act
        await readConfig(ctxA);
        await readConfig(ctxB);
        invalidateConfigCache(ctxA);
        await readConfig(ctxB);

        // Assert — ctxB still served from cache: only one read.
        expect(spyB).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a context never read before', () => {
    describe('When invalidateConfigCache is called', () => {
      it('Then no error is thrown', async () => {
        // Arrange — `cache.delete` of an absent key is a harmless no-op.
        const ctx = createMemoryContext();

        // Act
        const sut = (): void => invalidateConfigCache(ctx);

        // Assert
        expect(sut).not.toThrow();
      });
    });
  });

  describe('partial-clone keys', () => {
    describe('Given an [extensions] partialClone entry', () => {
      describe('When readConfig', () => {
        it('Then extensions.partialClone is set', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions]\n\tpartialClone = origin\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.extensions?.partialClone).toBe('origin');
        });
      });
    });

    describe('Given an [extensions] partialclone key in lower case', () => {
      describe('When readConfig', () => {
        it('Then it is still parsed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions]\n\tpartialclone = upstream\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.extensions?.partialClone).toBe('upstream');
        });
      });
    });

    describe('Given a config with no [extensions] section', () => {
      describe('When readConfig', () => {
        it('Then extensions is undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = false\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.extensions).toBeUndefined();
        });
      });
    });

    describe('Given a [remote] promisor = true', () => {
      describe('When readConfig', () => {
        it('Then the remote entry is a promisor', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://example.com/r.git\n\tpromisor = true\n',
          );

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.remote?.get('origin')?.promisor).toBe(true);
        });
      });
    });

    describe('Given a [remote] partialclonefilter', () => {
      describe('When readConfig', () => {
        it('Then the stored filter is parsed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://example.com/r.git\n\tpartialclonefilter = blob:none\n',
          );

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.remote?.get('origin')?.partialCloneFilter).toBe('blob:none');
        });
      });
    });

    describe('Given a [remote] url key in upper case', () => {
      describe('When readConfig', () => {
        it('Then it is still parsed', async () => {
          // Arrange — git config keys are case-insensitive.
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\tURL = https://example.com/r.git\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.remote?.get('origin')?.url).toBe('https://example.com/r.git');
        });
      });
    });

    describe('Given a [remote] with only a url', () => {
      describe('When readConfig', () => {
        it('Then promisor and filter stay undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = https://example.com/r.git\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          const remote = sut.remote?.get('origin');
          expect(remote?.promisor).toBeUndefined();
          expect(remote?.partialCloneFilter).toBeUndefined();
        });
      });
    });

    describe('Given a partialclone key under a non-extensions section', () => {
      describe('When readConfig', () => {
        it('Then extensions stays undefined', async () => {
          // Arrange — only the literal `[extensions]` section feeds mergeExtensions.
          const ctx = createMemoryContext();
          await seed(ctx, '[other]\npartialclone = origin\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.extensions).toBeUndefined();
        });
      });
    });

    describe('Given an [extensions "sub"] subsection', () => {
      describe('When readConfig', () => {
        it('Then it is NOT treated as [extensions]', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions "sub"]\n\tpartialclone = origin\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.extensions).toBeUndefined();
        });
      });
    });

    describe('Given a [remote] section with an unrecognised key', () => {
      describe('When readConfig', () => {
        it('Then partialCloneFilter stays undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e/r.git\n\tpushurl = https://e/p.git\n',
          );

          // Act
          const sut = await readConfig(ctx);

          // Assert — only the `partialclonefilter` key sets the field.
          expect(sut.remote?.get('origin')?.partialCloneFilter).toBeUndefined();
        });
      });
    });

    describe('Given an [extensions] section with a non-partialclone key', () => {
      describe('When readConfig', () => {
        it('Then partialClone stays undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[extensions]\nname = enabled\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert — only the `partialclone` key populates extensions.
          expect(sut.extensions?.partialClone).toBeUndefined();
        });
      });
    });
  });
});

describe('primitives/config-read parseIniSections', () => {
  describe('Given INI text with a subsection, comment, and continuation', () => {
    describe('When parseIniSections', () => {
      it('Then sections carry section/subsection/entries', () => {
        // Arrange
        const text =
          '[core]\n\tbare = true\n# a comment\n[remote "origin"]\n\turl = https://e\\\n/r.git\n';

        // Act
        const sut: ReadonlyArray<IniSection> = parseIniSections(text);

        // Assert
        expect(sut).toEqual([
          { section: 'core', subsection: undefined, entries: [{ key: 'bare', value: 'true' }] },
          {
            section: 'remote',
            subsection: 'origin',
            entries: [{ key: 'url', value: 'https://e/r.git' }],
          },
        ]);
      });
    });
  });

  describe('Given empty text', () => {
    describe('When parseIniSections', () => {
      it('Then returns no sections', () => {
        // Arrange
        const text = '';

        // Act
        const sut = parseIniSections(text);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  type ConfigToken,
  findFirstValuelessEntry,
  type IniSection,
  invalidateConfigCache,
  parseIniSections,
  readConfig,
  tokenizeConfig,
} from '../../../../src/application/primitives/config-read.js';
import {
  __resetSectionsCacheForTests,
  getAllConfigValues,
  getConfigValue,
  invalidateScopedConfigCache,
  readConfigSections,
} from '../../../../src/application/primitives/config-scoped-read.js';
import { qualifyKey } from '../../../../src/application/primitives/internal/config-key.js';
import { parseConfigKey } from '../../../../src/domain/commands/config-key.js';
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

  describe('Given a [submodule "libs/a"] section with url, active and update', () => {
    describe('When readConfig', () => {
      it('Then parsed.submodule.get("libs/a") is populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[submodule "libs/a"]\n  active = true\n  url = ../a\n  update = rebase\n  ignore = dirty\n',
        );

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.submodule?.get('libs/a')?.url).toBe('../a');
        expect(sut.submodule?.get('libs/a')?.active).toBe(true);
        expect(sut.submodule?.get('libs/a')?.update).toBe('rebase');
      });
    });
  });

  describe('Given a config with no submodule section', () => {
    describe('When readConfig', () => {
      it('Then parsed.submodule is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.submodule).toBeUndefined();
      });
    });
  });

  describe('Given a [merge "custom"] section with name, driver and recursive', () => {
    describe('When readConfig', () => {
      it('Then parsed.merge.get("custom") is populated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[merge "custom"]\n  name = my driver\n  driver = run %O %A %B\n  recursive = binary\n',
        );

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.merge?.get('custom')?.name).toBe('my driver');
        expect(sut.merge?.get('custom')?.driver).toBe('run %O %A %B');
        expect(sut.merge?.get('custom')?.recursive).toBe('binary');
      });
    });
  });

  describe('Given two [merge "<name>"] sections', () => {
    describe('When readConfig', () => {
      it('Then each driver is parsed independently', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "a"]\n  driver = tool-a\n[merge "b"]\n  driver = tool-b\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.merge?.get('a')?.driver).toBe('tool-a');
        expect(sut.merge?.get('b')?.driver).toBe('tool-b');
      });
    });
  });

  describe('Given a [merge "custom"] section with only a driver', () => {
    describe('When readConfig', () => {
      it('Then name and recursive are undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "custom"]\n  driver = tool\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.merge?.get('custom')?.driver).toBe('tool');
        expect(sut.merge?.get('custom')?.name).toBeUndefined();
        expect(sut.merge?.get('custom')?.recursive).toBeUndefined();
      });
    });
  });

  describe('Given a subsectionless [merge] section', () => {
    describe('When readConfig', () => {
      it('Then it is ignored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge]\n  driver = tool\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.merge).toBeUndefined();
      });
    });
  });

  describe('Given a config with no merge section', () => {
    describe('When readConfig', () => {
      it('Then parsed.merge is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bare = false\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.merge).toBeUndefined();
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
      it('Then the next line is concatenated with its leading whitespace preserved', async () => {
        // Arrange — Git supports backslash line continuation; the continuation
        // line's leading whitespace is interior to the value and survives.
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n  url = https://example.com/\\\n    really-long.git\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
        expect(sut.remote?.get('origin')?.url).toBe('https://example.com/    really-long.git');
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
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git', async () => {
        // Arrange — `[core` has no closing `]`; git refuses the whole file
        // (bad config line 1) rather than skipping the malformed header.
        const ctx = createMemoryContext();
        await seed(ctx, '[core\n  bare = true\n[user]\n  name = X\n  email = x@y.com\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse an unclosed section header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
            expect(err.data.source).toBe(`${ctx.layout.gitDir}/config`);
          }
        }
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
      it('Then it throws CONFIG_PARSE_ERROR (junk no-`=` line refused)', async () => {
        // Arrange — `.core]` starts with `.` so the valueless-key grammar refuses
        // it; git emits `bad config line 1 in file F` for the same input.
        const ctx = createMemoryContext();
        await seed(ctx, '.core]\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must throw on a junk no-`=` line');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 1 });
        }
      });
    });
  });

  describe('Given a header starting with `[` but missing `]`', () => {
    describe('When readConfig', () => {
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git', async () => {
        // Arrange — `[core.` starts with `[` but never closes; git refuses it.
        const ctx = createMemoryContext();
        await seed(ctx, '[core.\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse a header missing its `]`');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
          }
        }
      });
    });
  });

  describe('Given a header with neither bracket where one is required', () => {
    describe('When readConfig', () => {
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git', async () => {
        // Arrange — `[core)` has `[` but `)` not `]`, so it never closes; git refuses.
        const ctx = createMemoryContext();
        await seed(ctx, '[core)\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse a header with no closing bracket');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
          }
        }
      });
    });
  });

  describe('Given a `[remote "origin]` header with an unterminated subsection quote', () => {
    describe('When readConfig', () => {
      it('Then it throws CONFIG_PARSE_ERROR on the offending line', async () => {
        // Arrange — unclosed quote: git refuses the file with "bad config line N"
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin]\n  url = https://example.com/r.git\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must throw on an unclosed subsection quote');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 1 });
        }
      });
    });
  });

  describe('Given a `[core]` body line holding an unrecognized valueless key', () => {
    describe('When readConfig', () => {
      it('Then core stays undefined', async () => {
        // Arrange — `bareX` is a valid valueless key (boolean-true in git) but
        // not a key the [core] merge consumes; it must not synthesize `bare`.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  bareX\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert — an unrecognized key never promotes `core` into existence.
        expect(sut.core).toBeUndefined();
      });
    });
  });

  describe('Given a `[core]` string-typed key as a valueless entry', () => {
    describe('When readConfig', () => {
      it('Then the field is skipped and core stays undefined', async () => {
        // Arrange — `excludesfile` is string-typed; a valueless occurrence is
        // treated as absent and must not promote `core` into existence.
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n  excludesfile\n');

        // Act
        const sut = await readConfig(ctx);

        // Assert
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
      it('Then it refuses with CONFIG_PARSE_ERROR on line 1 like git (no trim-accept)', async () => {
        // Arrange — git's unquoted section grammar is `[A-Za-z0-9.-]+` with no
        // whitespace; `[ core ]` is not trimmed to `core` but refused outright.
        const ctx = createMemoryContext();
        await seed(ctx, '[ core ]\n  bare = true\n');

        // Act + Assert
        try {
          await readConfig(ctx);
          expect.unreachable('readConfig must refuse a whitespace-bearing header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          if (err.data.code === 'CONFIG_PARSE_ERROR') {
            expect(err.data.line).toBe(1);
            expect(err.data.source).toBe(`${ctx.layout.gitDir}/config`);
          }
        }
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

    describe('Given a [remote] pushurl set', () => {
      describe('When readConfig', () => {
        it('Then pushUrl is parsed alongside url', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(
            ctx,
            '[remote "origin"]\n\turl = https://e.com/r.git\n\tpushurl = git@e.com:r.git\n',
          );

          // Act
          const sut = await readConfig(ctx);

          // Assert
          const remote = sut.remote?.get('origin');
          expect(remote?.url).toBe('https://e.com/r.git');
          expect(remote?.pushUrl).toBe('git@e.com:r.git');
        });
      });
    });

    describe('Given a [remote] without pushurl', () => {
      describe('When readConfig', () => {
        it('Then pushUrl stays undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = https://e.com/r.git\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.remote?.get('origin')?.pushUrl).toBeUndefined();
        });
      });
    });

    describe('Given a [remote] PUSHURL upper-cased', () => {
      describe('When readConfig', () => {
        it('Then it is parsed (case-insensitive key)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\tPUSHURL = git@e.com:r.git\n');

          // Act
          const sut = await readConfig(ctx);

          // Assert
          expect(sut.remote?.get('origin')?.pushUrl).toBe('git@e.com:r.git');
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

describe('primitives/config-read value grammar', () => {
  const configTextFor = (raw: string): string => `[test]\n\tv = ${raw}\n`;

  const firstValue = (sections: ReadonlyArray<IniSection>): string | null | undefined =>
    sections[0]?.entries[0]?.value;

  describe('Given a quoted or quote-toggled value, When parseIniSections', () => {
    it.each([
      ['"a b"', 'a b'],
      ['a" b "c', 'a b c'],
      ['""', ''],
      ['"a "', 'a '],
      ['"a # c"', 'a # c'],
      ['"a ; c"', 'a ; c'],
    ])('Then %j parses to %j (quotes stripped, spans concatenated)', (raw, expected) => {
      // Arrange
      const sut = parseIniSections;
      const text = configTextFor(raw);

      // Act
      const result = sut(text);

      // Assert
      expect(firstValue(result)).toBe(expected);
    });
  });

  describe('Given escape sequences inside and outside quotes, When parseIniSections', () => {
    it.each([
      ['a\\nb', 'a\nb'],
      ['a\\tb', 'a\tb'],
      ['a\\bb', 'a\bb'],
      ['a\\"b', 'a"b'],
      ['a\\\\b', 'a\\b'],
      ['"a\\nb"', 'a\nb'],
      ['"a\\tb"', 'a\tb'],
      ['"a\\\\b"', 'a\\b'],
    ])('Then %j decodes to %j', (raw, expected) => {
      // Arrange
      const sut = parseIniSections;
      const text = configTextFor(raw);

      // Act
      const result = sut(text);

      // Assert
      expect(firstValue(result)).toBe(expected);
    });
  });

  describe('Given whitespace around and inside the value, When parseIniSections', () => {
    it.each([
      ['   a', 'a'],
      ['a   ', 'a'],
      ['a   b', 'a   b'],
      ['a\tb', 'a\tb'],
      ['a\r', 'a'],
      ['\ra', 'a'],
      ['a\rb', 'a\rb'],
      ['"a\r"', 'a\r'],
      ['\x0ba', '\x0ba'],
      ['a\x0b', 'a\x0b'],
      ['a\x0c', 'a\x0c'],
    ])('Then %j parses to %j (GIT_SPACE trim: space/tab/CR only)', (raw, expected) => {
      // Arrange
      const sut = parseIniSections;
      const text = configTextFor(raw);

      // Act
      const result = sut(text);

      // Assert
      expect(firstValue(result)).toBe(expected);
    });

    it('Then a quote toggle resets the trailing-whitespace trim', () => {
      // Arrange
      const sut = parseIniSections;
      const text = configTextFor('a ""');

      // Act
      const result = sut(text);

      // Assert
      expect(firstValue(result)).toBe('a ');
    });

    it('Then an escape append resets the trailing-whitespace trim', () => {
      // Arrange
      const sut = parseIniSections;
      const text = configTextFor('a \\t');

      // Act
      const result = sut(text);

      // Assert
      expect(firstValue(result)).toBe('a \t');
    });
  });

  describe('Given backslash continuations, When parseIniSections', () => {
    it('Then the continuation line leading whitespace is preserved as interior', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = a\\\n   b\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result[0]?.entries).toEqual([{ key: 'v', value: 'a   b' }]);
    });

    it('Then an escaped backslash at end of line is not a continuation', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = a\\\\\n\tw = c\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result[0]?.entries).toEqual([
        { key: 'v', value: 'a\\' },
        { key: 'w', value: 'c' },
      ]);
    });

    it('Then a continuation inside a quote span carries the quote state across lines', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = "a\\\nb"\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result[0]?.entries).toEqual([{ key: 'v', value: 'ab' }]);
    });

    it('Then a continuation on the final line ends the value without error', () => {
      // Arrange — git fakes an end-of-line at EOF.
      const sut = parseIniSections;
      const text = '[test]\n\tv = a\\';

      // Act
      const result = sut(text);

      // Assert
      expect(result[0]?.entries).toEqual([{ key: 'v', value: 'a' }]);
    });

    it('Then a section header after a continued value is still recognized', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = a\\\nb\n[next]\n\tw = c\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 'test', subsection: undefined, entries: [{ key: 'v', value: 'ab' }] },
        { section: 'next', subsection: undefined, entries: [{ key: 'w', value: 'c' }] },
      ]);
    });
  });

  describe('Given comment characters, When parseIniSections', () => {
    it('Then an unquoted hash starts a comment and trailing whitespace is trimmed', () => {
      // Arrange
      const sut = parseIniSections;
      const text = configTextFor('a # c');

      // Act
      const result = sut(text);

      // Assert
      expect(firstValue(result)).toBe('a');
    });

    it.each([
      ['hash', '[test]\n\tab#cd = x\n\tv = ok\n'],
      ['semicolon', '[test]\n\tab;cd = x\n\tv = ok\n'],
    ])('Then a %s comment before the equals sign causes CONFIG_PARSE_ERROR', (_label, text) => {
      // Arrange — the comment swallows the `=`, landing the line on the
      // valueless-key path; `ab#cd` / `ab;cd` fail the key grammar → git refuses.
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut(text, 'test.cfg');
        expect.unreachable('parseIniSections must throw when comment swallows =');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
      }
    });

    it('Then a line with a semicolon before = and a hash after = causes CONFIG_PARSE_ERROR', () => {
      // Arrange — the `;` before `=` swallows the `=`; `a;b` fails the key
      // grammar (semicolon is not alnum/dash) → git refuses the file.
      const sut = parseIniSections;
      const text = '[test]\n\ta;b = x # y\n\tv = ok\n';

      // Act + Assert
      try {
        sut(text, 'test.cfg');
        expect.unreachable('parseIniSections must throw on comment-swallowed = line');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
      }
    });

    it('Then an unindented comment-swallowed line causes CONFIG_PARSE_ERROR', () => {
      // Arrange — without indentation the key starts at column 0; the `;` still
      // fails the grammar and git refuses the file with `bad config line N`.
      const sut = parseIniSections;
      const text = '[test]\na;b = x # y\nv = ok\n';

      // Act + Assert
      try {
        sut(text, 'test.cfg');
        expect.unreachable('parseIniSections must throw on unindented comment-swallowed line');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
      }
    });
  });

  describe('Given section headers carrying comments and quoted names, When parseIniSections', () => {
    it.each([
      ['hash-then-semicolon', '[test] # c ; d\n\tv = ok\n'],
      ['semicolon-then-hash', '[test] ; c # d\n\tv = ok\n'],
    ])('Then a %s trailing comment is cut at the earliest marker', (_label, text) => {
      // Arrange
      const sut = parseIniSections;

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 'test', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });

    it('Then a comment after a closed quoted subsection is still cut', () => {
      // Arrange — the quote span must CLOSE at its second `"` so the later
      // `#` is unquoted again and the trailing comment is stripped.
      const sut = parseIniSections;
      const text = '[branch "a"] # c\n\tv = ok\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 'branch', subsection: 'a', entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });

    it('Then a hash inside a quoted subsection is not a comment', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[branch "a#b"]\n\tv = ok\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 'branch', subsection: 'a#b', entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });

    it('Then a backslash-escaped quote inside a quoted subsection is decoded and does not close the span', () => {
      // Arrange — `\"` decodes to `"` (not verbatim `\"`); the `#` after it stays
      // inside the span and becomes part of the subsection name, not a comment.
      const sut = parseIniSections;
      const text = '[branch "a\\"#b"]\n\tv = ok\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 'branch', subsection: 'a"#b', entries: [{ key: 'v', value: 'ok' }] },
      ]);
    });
  });

  describe('Given a quoted subsection with escape sequences, When parseIniSections', () => {
    it('Then `\\"` in the subsection is decoded to `"`', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a\\"b"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a"b', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then `\\\\` in the subsection is decoded to `\\`', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a\\\\b"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a\\b', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then `\\t` (backslash + letter t) is decoded to `t` — no named escapes', () => {
      // Arrange — subsection grammar has NO named escapes; `\c` → `c` for any `c`
      const sut = parseIniSections;
      const text = '[s "a\\tb"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'atb', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then a literal `]` inside the quoted subsection is content, not the header close', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a]b"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a]b', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then `#` inside the quoted subsection is content, not a comment', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a#b"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a#b', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then `;` inside the quoted subsection is content, not a comment', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a;b"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a;b', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then a raw CR inside the quoted subsection is content', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a\rb"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a\rb', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then a TAB between the section name and the opening quote is accepted (GIT_SPACE)', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s\t"a"]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then a trailing comment after the closing `]` is stripped', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s "a"] # trailing comment\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: 'a', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });

    it('Then an empty quoted subsection `""` yields an empty string (not undefined)', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[s ""]\n\tk = v\n';

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { section: 's', subsection: '', entries: [{ key: 'k', value: 'v' }] },
      ]);
    });
  });

  describe('Given a malformed quoted subsection header, When parseIniSections', () => {
    it('Then `[s "a" x]` — junk after the closing quote — throws CONFIG_PARSE_ERROR with partial `s.a`', () => {
      // Arrange
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[s "a" x]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw on junk after closing quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({
          line: 1,
          source: 'test-source',
          partialSectionName: 's.a',
        });
      }
    });

    it('Then `[s "a" ]` — space before closing `]` — throws CONFIG_PARSE_ERROR with partial `s.a`', () => {
      // Arrange
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[s "a" ]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw on space before closing bracket');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({
          line: 1,
          source: 'test-source',
          partialSectionName: 's.a',
        });
      }
    });

    it('Then `[s"a"]` — no space before the quote — throws CONFIG_PARSE_ERROR with partial `s`', () => {
      // Arrange
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[s"a"]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw when quote is not preceded by whitespace');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 1, source: 'test-source', partialSectionName: 's' });
      }
    });

    it('Then `["a"]` — no section, quote directly after `[` — throws CONFIG_PARSE_ERROR with partial `"` empty', () => {
      // Arrange
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('["a"]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw when no section precedes the quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 1, source: 'test-source', partialSectionName: '' });
      }
    });

    it('Then `[s "a]` — unclosed quote — throws CONFIG_PARSE_ERROR with partial `s.a]`', () => {
      // Arrange
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[s "a]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw on unclosed subsection quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({
          line: 1,
          source: 'test-source',
          partialSectionName: 's.a]',
        });
      }
    });

    it('Then `[s "a\\"b]` — escaped quote then unclosed — throws CONFIG_PARSE_ERROR with partial `s.a"b]`', () => {
      // Arrange — `\"` inside the span decodes to `"`, then the span is never closed
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[s "a\\"b]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw on unclosed span after escaped quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({
          line: 1,
          source: 'test-source',
          partialSectionName: 's.a"b]',
        });
      }
    });

    it('Then `[s "ab\\` — dangling backslash at end of line — throws CONFIG_PARSE_ERROR with partial `s.ab`', () => {
      // Arrange — `\` at end of inner span (after stripping `]`) is fatal
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[s "ab\\\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw on dangling backslash in subsection');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({
          line: 1,
          source: 'test-source',
          partialSectionName: 's.ab',
        });
      }
    });

    it('Then `[S "a" x]` — uppercase section — throws with partial `s.a` (section lowercased)', () => {
      // Arrange
      const sut = parseIniSections;

      // Act + Assert
      try {
        sut('[S "a" x]\n\tk = v\n', 'test-source');
        expect.unreachable('parseIniSections must throw on junk after closing quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({
          line: 1,
          source: 'test-source',
          partialSectionName: 's.a',
        });
      }
    });

    it('Then a malformed header on line 3 of a multi-line file reports `line: 3`', () => {
      // Arrange — two well-formed lines precede the malformed header
      const sut = parseIniSections;
      const text = '[a]\n\tk = v\n[s "bad" x]\n\tw = ok\n';

      // Act + Assert
      try {
        sut(text, 'test-source');
        expect.unreachable('parseIniSections must throw on the malformed header');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 3 });
      }
    });
  });

  describe('Given a malformed value, When parseIniSections', () => {
    it('Then an unknown escape throws CONFIG_PARSE_ERROR with the physical line', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = a\\xb\n';

      // Act + Assert
      try {
        sut(text);
        expect.unreachable('parseIniSections must throw on an unknown escape');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 2 });
      }
    });

    it('Then an unclosed quote throws CONFIG_PARSE_ERROR with the physical line', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[a]\nk = ok\n[test]\nv = "good"\nw = "bad\n';

      // Act + Assert
      try {
        sut(text);
        expect.unreachable('parseIniSections must throw on an unclosed quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 5 });
      }
    });

    it('Then a failure on a continuation line reports the continuation physical line', () => {
      // Arrange — value starts on line 2; the bad escape sits on line 3.
      const sut = parseIniSections;
      const text = '[test]\n\tv = a\\\nb\\q\n';

      // Act + Assert
      try {
        sut(text);
        expect.unreachable('parseIniSections must throw on an unknown escape');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(err.data).toMatchObject({ line: 3 });
      }
    });

    it('Then the source label is carried when provided', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = "bad\n';

      // Act + Assert
      try {
        sut(text, 'some/config');
        expect.unreachable('parseIniSections must throw on an unclosed quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data).toMatchObject({ code: 'CONFIG_PARSE_ERROR', source: 'some/config' });
      }
    });

    it('Then the source label is absent when not provided', () => {
      // Arrange
      const sut = parseIniSections;
      const text = '[test]\n\tv = "bad\n';

      // Act + Assert
      try {
        sut(text);
        expect.unreachable('parseIniSections must throw on an unclosed quote');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        expect(Object.hasOwn(err.data, 'source')).toBe(false);
      }
    });
  });

  describe('Given a malformed .git/config, When readConfig', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
    });

    it('Then it rejects with CONFIG_PARSE_ERROR carrying the config path as source', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n\tbare = a\\x\n');

      // Act + Assert
      try {
        await readConfig(ctx);
        expect.unreachable('readConfig must reject on a malformed config');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data).toMatchObject({
          code: 'CONFIG_PARSE_ERROR',
          line: 2,
          source: `${ctx.layout.gitDir}/config`,
        });
      }
    });

    it('Then the rejection is cached (single underlying read)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n\tbare = "open\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      const first = readConfig(ctx).catch((err: unknown) => err);
      const second = readConfig(ctx).catch((err: unknown) => err);
      const [a, b] = await Promise.all([first, second]);

      // Assert — both rejections come from one read.
      expect((a as TsgitError).data.code).toBe('CONFIG_PARSE_ERROR');
      expect((b as TsgitError).data.code).toBe('CONFIG_PARSE_ERROR');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Given a malformed local config, When getConfigValue reads scoped sections', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
      __resetSectionsCacheForTests();
    });

    it('Then the CONFIG_PARSE_ERROR propagates (not swallowed as a missing scope)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = "open\n');

      // Act + Assert
      try {
        await getConfigValue({ ctx, key: 'user.name' });
        expect.unreachable('getConfigValue must reject on a malformed config');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
      }
    });
  });
});

describe('readConfigSections / getConfigValue / getAllConfigValues', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given a local config with one [user] section, When readConfigSections runs for scope local', () => {
    it('Then returns one tagged section', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');

      // Act
      const sut = await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.scope).toBe('local');
      expect(sut[0]?.section.section).toBe('user');
    });
  });

  describe('Given an absent local config, When readConfigSections runs for scope local', () => {
    it('Then returns an empty array (missing file is not an error)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const sut = await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(sut).toEqual([]);
    });
  });

  describe('Given two consecutive readConfigSections calls for the same scope, When the second runs', () => {
    it('Then fs.readUtf8 is called exactly once (cache hit)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      await readConfigSections({ ctx, scope: 'local' });
      await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Given a scoped-cache invalidation between two calls, When the second readConfigSections runs', () => {
    it('Then fs.readUtf8 is called twice (cache miss after invalidate)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');
      const spy = vi.spyOn(ctx.fs, 'readUtf8');

      // Act
      await readConfigSections({ ctx, scope: 'local' });
      invalidateScopedConfigCache(ctx);
      await readConfigSections({ ctx, scope: 'local' });

      // Assert
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given getConfigValue with the key present once, When called', () => {
    it('Then returns { key, value, scope: local }', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n');

      // Act
      const sut = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

      // Assert
      expect(sut).toEqual({ key: 'user.name', value: 'ada', scope: 'local' });
    });
  });

  describe('Given getConfigValue with the key absent, When called', () => {
    it('Then returns { key, value: undefined } (no scope)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const sut = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

      // Assert
      expect(sut).toEqual({ key: 'user.name', value: undefined });
    });
  });

  describe('Given getConfigValue with the key appearing twice in local, When called', () => {
    it('Then throws CONFIG_MULTIPLE_VALUES with requested=read, count=2, scope=local', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[user]\n\tname = ada\n\tname = bob\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'user.name',
        count: 2,
        requested: 'read',
        scope: 'local',
      });
    });
  });

  describe('Given getAllConfigValues for a multi-valued key, When called', () => {
    it('Then returns all values in physical order tagged with their scope', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(
        ctx,
        '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch = +refs/tags/*:refs/tags/*\n',
      );

      // Act
      const sut = await getAllConfigValues({
        ctx,
        key: 'remote.origin.fetch',
        scope: 'local',
      });

      // Assert
      expect(sut.values).toEqual([
        { value: '+refs/heads/*:refs/remotes/origin/*', scope: 'local' },
        { value: '+refs/tags/*:refs/tags/*', scope: 'local' },
      ]);
    });
  });

  describe('Given getAllConfigValues for an absent key, When called', () => {
    it('Then returns { key, values: [] }', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const sut = await getAllConfigValues({ ctx, key: 'user.email', scope: 'local' });

      // Assert
      expect(sut).toEqual({ key: 'user.email', values: [] });
    });
  });

  describe('Given a valueless key, When getConfigValue', () => {
    it('Then returns { key, value: null, scope } (distinct from absent → value: undefined)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\nbare\n');

      // Act
      const result = await getConfigValue({ ctx, key: 'core.bare', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'core.bare', value: null, scope: 'local' });
    });
  });

  describe('Given an absent key, When getConfigValue', () => {
    it('Then returns { key, value: undefined } (distinct from valueless → value: null)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n');

      // Act
      const result = await getConfigValue({ ctx, key: 'core.bare', scope: 'local' });

      // Assert
      expect(result).toEqual({ key: 'core.bare', value: undefined });
    });
  });

  describe('Given a key with one valued and one valueless occurrence, When getAllConfigValues', () => {
    it('Then values array carries null in physical file order', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(
        ctx,
        '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch\n',
      );

      // Act
      const result = await getAllConfigValues({
        ctx,
        key: 'remote.origin.fetch',
        scope: 'local',
      });

      // Assert
      expect(result.values).toEqual([
        { value: '+refs/heads/*:refs/remotes/origin/*', scope: 'local' },
        { value: null, scope: 'local' },
      ]);
    });
  });
});

describe('primitives/config-read valueless keys', () => {
  describe('parseIniSections — valueless entry tokenisation', () => {
    describe('Given [a]\\n\\tkey\\n, When parseIniSections', () => {
      it('Then one entry with key and value null', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tkey\n');

        // Assert
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });

    describe('Given valueless key with trailing spaces, When parseIniSections', () => {
      it('Then value is null (trailing spaces accepted)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tkey   \n');

        // Assert
        expect(result[0]?.entries).toEqual([{ key: 'key', value: null }]);
      });
    });

    describe('Given valueless key with trailing tab, When parseIniSections', () => {
      it('Then value is null (trailing tab accepted)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tkey\t\n');

        // Assert
        expect(result[0]?.entries).toEqual([{ key: 'key', value: null }]);
      });
    });

    describe('Given valueless key with trailing CR (CRLF line), When parseIniSections', () => {
      it('Then value is null (CR at EOL accepted)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tkey\r\n');

        // Assert
        expect(result[0]?.entries).toEqual([{ key: 'key', value: null }]);
      });
    });

    describe('Given valueless key with leading whitespace, When parseIniSections', () => {
      it('Then value is null (leading whitespace accepted)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n   key\n');

        // Assert
        expect(result[0]?.entries).toEqual([{ key: 'key', value: null }]);
      });
    });

    describe('Given valueless key With-CAPS, When parseIniSections', () => {
      it('Then key case is preserved and value is null', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tWith-CAPS\n');

        // Assert
        expect(result[0]?.entries).toEqual([{ key: 'With-CAPS', value: null }]);
      });
    });

    describe('Given valueless key at EOF with no trailing newline, When parseIniSections', () => {
      it('Then value is null (no trailing newline accepted)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\nkey');

        // Assert
        expect(result[0]?.entries).toEqual([{ key: 'key', value: null }]);
      });
    });
  });

  describe('parseIniSections — refusal matrix', () => {
    describe('Given key with inline semicolon comment (key ; c), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2 and the source', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\nkey ; c\n', 'test.cfg');
          expect.unreachable('must throw on key with inline comment');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given key with inline hash comment (key # c), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2 and the source', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\nkey # c\n', 'test.cfg');
          expect.unreachable('must throw on key with inline hash comment');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given key with exclamation (bad!key), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\nbad!key\n', 'test.cfg');
          expect.unreachable('must throw on bad!key');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given key starting with digit (9key), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\n9key\n', 'test.cfg');
          expect.unreachable('must throw on 9key');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given key starting with dash (-key), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\n-key\n', 'test.cfg');
          expect.unreachable('must throw on -key');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given key with underscore (under_score), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\nunder_score\n', 'test.cfg');
          expect.unreachable('must throw on under_score');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given key with lone CR before trailing space (key\\r ), When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR with line 2', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\nkey\r \n', 'test.cfg');
          expect.unreachable('must throw on key with CR not at EOL');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });

    describe('Given ab#cd = x where comment swallows the =, When parseIniSections', () => {
      it('Then throws CONFIG_PARSE_ERROR (refused like git)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        try {
          sut('[a]\n\tab#cd = x\n', 'test.cfg');
          expect.unreachable('must throw when comment swallows =');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2, source: 'test.cfg' });
        }
      });
    });
  });

  describe('parseIniSections — leniency preserved', () => {
    describe('Given a valid valueless key before any section (orphan), When parseIniSections', () => {
      it('Then the orphan records under the empty section ahead of the named section', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('key\n[a]\n\tv = ok\n');

        // Assert
        expect(result).toEqual([
          { section: '', subsection: undefined, entries: [{ key: 'key', value: null }] },
          { section: 'a', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
        ]);
      });
    });

    describe('Given `[a] key` on a header line followed by a body entry, When parseIniSections', () => {
      it('Then the header opens a section and the same-line valueless key joins the body entry', () => {
        // Arrange — `[a] key` is a header `[a]` plus a same-line valueless entry;
        // the following `v = ok` lands in the same re-opened section.
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n[a] key\n\tv = ok\n');

        // Assert — first `[a]` is empty; the second carries the same-line key and `v`.
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [] },
          {
            section: 'a',
            subsection: undefined,
            entries: [
              { key: 'key', value: null },
              { key: 'v', value: 'ok' },
            ],
          },
        ]);
      });
    });

    describe('Given a full-line comment, When parseIniSections', () => {
      it('Then skipped and no throw', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n# comment\n\tv = ok\n');

        // Assert
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
        ]);
      });
    });

    describe('Given a blank line, When parseIniSections', () => {
      it('Then skipped and no throw', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\n\tv = ok\n');

        // Assert
        expect(result).toEqual([
          { section: 'a', subsection: undefined, entries: [{ key: 'v', value: 'ok' }] },
        ]);
      });
    });
  });

  describe('readConfig — bool semantics via valueless keys', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
    });

    describe('Given [core]\\nbare (valueless), When readConfig', () => {
      it('Then core.bare is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(true);
      });
    });

    describe('Given [core]\\nsparsecheckout (valueless), When readConfig', () => {
      it('Then core.sparseCheckout is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nsparsecheckout\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.sparseCheckout).toBe(true);
      });
    });

    describe('Given [core]\\nlogallrefupdates (valueless), When readConfig', () => {
      it('Then core.logAllRefUpdates is true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nlogallrefupdates\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.logAllRefUpdates).toBe(true);
      });
    });

    describe('Given [core]\\nbare = (empty value), When readConfig', () => {
      it('Then core.bare is false (empty string is falsy)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\nbare =\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.core?.bare).toBe(false);
      });
    });
  });

  describe('readConfig — string-typed fields skip valueless entries', () => {
    beforeEach(() => {
      __resetConfigCacheForTests();
    });

    describe('Given [user]\\nname\\nemail = e, When readConfig', () => {
      it('Then user is undefined (valueless name skipped, pair incomplete)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\nname\nemail = e\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.user).toBeUndefined();
      });
    });

    describe('Given [remote "o"]\\nurl\\nfetch (both valueless), When readConfig', () => {
      it('Then remote o has no url and no fetch entries', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\nurl\nfetch\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        const remote = result.remote?.get('o');
        expect(remote?.url).toBeUndefined();
        expect(remote?.fetch).toBeUndefined();
      });
    });

    describe('Given [merge "d"]\\ndriver (valueless), When readConfig', () => {
      it('Then merge driver d has no driver field (valueless string skipped)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[merge "d"]\ndriver\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the section is present but driver (string field) skips null
        expect(result.merge?.get('d')?.driver).toBeUndefined();
      });
    });

    describe('Given [submodule "s"]\\nactive (valueless bool), When readConfig', () => {
      it('Then submodule s has active true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[submodule "s"]\nactive\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.submodule?.get('s')?.active).toBe(true);
      });
    });

    describe('Given [remote "o"]\\npromisor (valueless bool), When readConfig', () => {
      it('Then remote o has promisor true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "o"]\nurl = u\npromisor\n');

        // Act
        const result = await readConfig(ctx);

        // Assert
        expect(result.remote?.get('o')?.promisor).toBe(true);
      });
    });

    describe('Given [branch "b"]\\nremote\\nmerge (both valueless), When readConfig', () => {
      it('Then branch b has neither remote nor merge (valueless strings skipped)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[branch "b"]\nremote\nmerge\n');

        // Act
        const result = await readConfig(ctx);

        // Assert — the section is present but both string fields skip null
        expect(result.branch?.get('b')?.remote).toBeUndefined();
        expect(result.branch?.get('b')?.merge).toBeUndefined();
      });
    });
  });
});

describe('primitives/config-read tokenizeConfig', () => {
  describe('Given a simple section with one entry, When tokenizeConfig', () => {
    it('Then returns a header token followed by an entry token with correct span', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tkey = v\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'v', startLine: 1, endLine: 2 },
      ]);
    });
  });

  describe('Given a backslash continuation, When tokenizeConfig', () => {
    it('Then the entry spans both physical lines with the joined value', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tkey = one\\\n   two\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one   two', startLine: 1, endLine: 3 },
      ]);
    });
  });

  describe('Given chained backslash continuations, When tokenizeConfig', () => {
    it('Then the entry spans all physical lines with endLine equal to the last continuation plus one', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tkey = one\\\n   two\\\n   three\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one   two   three', startLine: 1, endLine: 4 },
      ]);
    });
  });

  describe('Given a quoted continuation, When tokenizeConfig', () => {
    it('Then the entry spans both physical lines with the concatenated quoted value', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tkey = "one\\\n   two"\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one   two', startLine: 1, endLine: 3 },
      ]);
    });
  });

  describe('Given a backslash inside a trailing comment, When tokenizeConfig', () => {
    it('Then the backslash is not a continuation and the next line is a separate entry', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tkey = one # c\\\n\tnext = x\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: 'one', startLine: 1, endLine: 2 },
        { kind: 'entry', key: 'next', value: 'x', startLine: 2, endLine: 3 },
      ]);
    });
  });

  describe('Given a continuation tail that looks like a key line, When tokenizeConfig', () => {
    it('Then the tail is value content and only the real url entry is emitted', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tnote = first\\\n\turl = fake\n\turl = real\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'note', value: 'first\turl = fake', startLine: 1, endLine: 3 },
        { kind: 'entry', key: 'url', value: 'real', startLine: 3, endLine: 4 },
      ]);
    });
  });

  describe('Given a continuation tail that looks like a section header, When tokenizeConfig', () => {
    it('Then only one header token is emitted and note spans both physical lines', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tnote = v\\\n[x]\n\tkey = old\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'note', value: 'v[x]', startLine: 1, endLine: 3 },
        { kind: 'entry', key: 'key', value: 'old', startLine: 3, endLine: 4 },
      ]);
    });
  });

  describe('Given blank lines and comment lines, When tokenizeConfig', () => {
    it('Then blank lines emit blank tokens and comment lines emit comment tokens', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\n# c\n   ; c\n   \n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'blank', line: 1 },
        { kind: 'comment', line: 2 },
        { kind: 'comment', line: 3 },
        { kind: 'blank', line: 4 },
      ]);
    });
  });

  describe('Given a header with or without an inline comment, When tokenizeConfig', () => {
    it('Then hasComment is true when an unquoted inline comment is present and false otherwise', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const withComment = sut('[a] # note\n');
      const withSemicolonComment = sut('[a] ; note\n');
      const withoutComment = sut('[a]\n');
      const quotedHash = sut('[a "x#y"]\n');

      // Assert
      expect((withComment[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(true);
      expect((withSemicolonComment[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(
        true,
      );
      expect((withoutComment[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(
        false,
      );
      expect((quotedHash[0] as Extract<ConfigToken, { kind: 'header' }>).hasComment).toBe(false);
    });
  });

  describe('Given a not-header body line starting with [ (`[half`), When tokenizeConfig', () => {
    it('Then it refuses with CONFIG_PARSE_ERROR on its physical line like git', () => {
      // Arrange — `[half` is not a valid header and has no key char at column 0,
      // so git refuses it (bad config line 2); the parser must not skip it.
      const sut = tokenizeConfig;

      // Act + Assert
      try {
        sut('[a]\n\t[half\n');
        expect.unreachable('tokenizeConfig must refuse a bracket-shaped non-header line');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        if (err.data.code === 'CONFIG_PARSE_ERROR') {
          expect(err.data.line).toBe(2);
        }
      }
    });
  });

  describe('Given a valueless entry, When tokenizeConfig', () => {
    it('Then the entry token has a null value and a single-line span', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const result = sut('[a]\n\tkey\n');

      // Assert
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'key', value: null, startLine: 1, endLine: 2 },
      ]);
    });
  });

  describe('Given a line whose key is missing (`\\t= v`), When tokenizeConfig', () => {
    it('Then it refuses with CONFIG_PARSE_ERROR on its physical line (no key char before `=`)', () => {
      // Arrange
      const sut = tokenizeConfig;
      const input = '[a]\n\t= v\n';

      // Act + Assert — the key scanner requires an alpha first char
      try {
        sut(input);
        expect.unreachable('tokenizeConfig must refuse a line with no key');
      } catch (err) {
        if (!(err instanceof TsgitError)) throw err;
        expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
        if (err.data.code === 'CONFIG_PARSE_ERROR') {
          expect(err.data.line).toBe(2);
        }
      }
    });
  });

  describe('Given an orphan entry before any header, When tokenizeConfig', () => {
    it('Then the orphan entry token precedes the header token and parseIniSections records the orphan section', () => {
      // Arrange
      const sut = tokenizeConfig;
      const input = 'key = v\n[a]\n';

      // Act
      const tokens = sut(input);
      const sections = parseIniSections(input);

      // Assert
      expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'entry', key: 'key', value: 'v', startLine: 0, endLine: 1 },
        { kind: 'header', section: 'a', subsection: undefined, line: 1, hasComment: false },
      ]);
      // fold parity: the orphan entry records under the empty section, ahead of [a]
      expect(sections).toEqual<ReadonlyArray<IniSection>>([
        { section: '', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        { section: 'a', subsection: undefined, entries: [] },
      ]);
    });
  });

  describe('Given text with a single trailing newline versus two trailing newlines, When tokenizeConfig', () => {
    it('Then the LF terminator emits no token but a second blank line does emit a blank token', () => {
      // Arrange
      const sut = tokenizeConfig;

      // Act
      const singleNewline = sut('[a]\n');
      const doubleNewline = sut('[a]\n\n');

      // Assert
      expect(singleNewline).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
      ]);
      expect(doubleNewline).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'blank', line: 1 },
      ]);
    });
  });

  describe('Given a continuation that consumes the EOF terminator, When tokenizeConfig', () => {
    it('Then the entry endLine equals the split-array length pinning the exclusive-end contract at EOF', () => {
      // Arrange
      const sut = tokenizeConfig;
      const input = '[a]\n\tk = v\\\n';

      // Act
      const result = sut(input);

      // Assert
      const lines = input.split('\n');
      expect(result).toEqual<ReadonlyArray<ConfigToken>>([
        { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
        { kind: 'entry', key: 'k', value: 'v', startLine: 1, endLine: lines.length },
      ]);
    });
  });

  describe('Given a malformed section header', () => {
    describe('When tokenizeConfig parses it', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1 and the partial section name', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act + Assert
        try {
          sut('[s "a" x]\n\tk = v\n');
          expect.unreachable('tokenizeConfig must refuse a malformed header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 1, partialSectionName: 's.a' });
        }
      });
    });
  });

  describe('Given a bad key line under a valid header', () => {
    describe('When tokenizeConfig parses it', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act + Assert
        try {
          sut('[a]\nbad!key\n');
          expect.unreachable('tokenizeConfig must refuse a bad key line');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2 });
        }
      });
    });
  });

  describe('Given an entry value with an unclosed quote', () => {
    describe('When tokenizeConfig parses it', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act + Assert
        try {
          sut('[a]\nk = "unclosed\n');
          expect.unreachable('tokenizeConfig must refuse an unclosed quote');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
          expect(err.data).toMatchObject({ line: 2 });
        }
      });
    });
  });

  describe('Given a malformed header and a source label', () => {
    describe('When tokenizeConfig and parseIniSections parse it', () => {
      it('Then both errors carry the source label', () => {
        // Arrange
        const sut = tokenizeConfig;
        const source = 'my-config';

        // Act + Assert — tokenizeConfig carries the source label
        try {
          sut('[s "a" x]\n\tk = v\n', source);
          expect.unreachable('tokenizeConfig must refuse a malformed header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data).toMatchObject({ code: 'CONFIG_PARSE_ERROR', source });
        }

        // Act + Assert — parseIniSections carries the same source label
        try {
          parseIniSections('[s "a" x]\n\tk = v\n', source);
          expect.unreachable('parseIniSections must refuse a malformed header');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data).toMatchObject({ code: 'CONFIG_PARSE_ERROR', source });
        }
      });
    });
  });
});

describe('Given a config with valueless/valued entries', () => {
  describe('When findFirstValuelessEntry', () => {
    it('Then returns the valueless entry for a matching key (step 2: single valueless key)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\tname\n\temail = a@b.c\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(2);
      expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
    });

    it('Then returns undefined when all keys are valued (step 3: valued only)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\tname = Ada\n\temail = a@b.c\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined when the key is absent (step 4: key absent)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\temail = a@b.c\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined when config is empty (step 4: empty config)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined when config file does not exist (step 4: missing file)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;

      // Act
      const result = await sut(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns the valueless email when name is valued (step 5: file-order, valued name)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\tname = Ada\n\temail\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.email');
      expect(result?.line).toBe(3);
    });

    it('Then returns the first valueless when name appears before email (step 6: both valueless, name earlier)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\tname\n\temail\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(2);
    });

    it('Then returns the first valueless when email appears before name (step 7: discriminator — file-position order)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\temail\n\tname\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result?.key).toBe('user.email');
      expect(result?.line).toBe(2);
    });

    it('Then matches the key case-insensitively and returns canonical lower-case (step 8)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\tNAME\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(2);
    });

    it('Then does not match entries under the wrong section (step 9: negative scoping)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[other]\n\tname\n[user]\n\temail = a@b.c\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns the entry only under the correct section (step 9: positive scoping)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[other]\n\tname\n[user]\n\tname\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name']);

      // Assert
      expect(result?.key).toBe('user.name');
      expect(result?.line).toBe(4);
    });

    it('Then returns the full qualified key including subsection (step 10: subsection match)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[remote "origin"]\n\turl\n');

      // Act
      const result = await sut(ctx, 'remote', 'origin', ['url']);

      // Assert
      expect(result?.key).toBe('remote.origin.url');
      expect(result?.line).toBe(2);
      expect(result?.source).toBe(`${ctx.layout.gitDir}/config`);
    });

    it('Then returns undefined when subsection does not match (step 10: subsection mismatch)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[remote "origin"]\n\turl\n');

      // Act
      const result = await sut(ctx, 'remote', 'other', ['url']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then matches the subsection case-sensitively (a differing case does not match)', async () => {
      // Arrange — git subsection names are case-SENSITIVE, unlike section names.
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[remote "Origin"]\n\turl\n');

      // Act
      const result = await sut(ctx, 'remote', 'origin', ['url']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined for a valueless target key that appears before any section header', async () => {
      // Arrange — a pre-header bare key must NOT match: inSection starts false
      // and is only set to true when a matching [section] header is seen.
      // Mutant (inSection=true) would wrongly return the pre-header entry.
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '\tname\n[user]\n\temail = a@b.c\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Then returns undefined for a valueless non-target key under the matching section', async () => {
      // Arrange — a valueless key that is NOT in the requested key set must be
      // skipped. Mutant (!keySet.has → false) would wrongly return it.
      const ctx = createMemoryContext();
      const sut = findFirstValuelessEntry;
      await seed(ctx, '[user]\n\tfoo\n\temail = a@b.c\n');

      // Act
      const result = await sut(ctx, 'user', undefined, ['name', 'email']);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Char-wise same-line, orphan, and key-grammar config parsing', () => {
  const headerToken = (
    section: string,
    subsection: string | undefined,
    line: number,
  ): ConfigToken => ({ kind: 'header', section, subsection, line, hasComment: false });

  const assertParseConfigRefuses = (input: string, line: number): void => {
    try {
      parseIniSections(input, 'test.cfg');
      expect.unreachable(`must throw CONFIG_PARSE_ERROR on line ${line}`);
    } catch (err) {
      if (!(err instanceof TsgitError)) throw err;
      expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
      if (err.data.code === 'CONFIG_PARSE_ERROR') {
        expect(err.data.line).toBe(line);
        expect(err.data.source).toBe('test.cfg');
      }
    }
  };

  describe('header and entry on the same physical line', () => {
    describe('Given `[a] key = v`, When tokenizeConfig', () => {
      it('Then a header token is followed by a shared-line entry token and the section records a.key = v', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const tokens = sut('[a] key = v\n');
        const sections = parseIniSections('[a] key = v\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'v',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 4,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a] key` (valueless same-line), When tokenizeConfig', () => {
      it('Then a shared-line valueless entry token follows the header', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const tokens = sut('[a] key\n');
        const sections = parseIniSections('[a] key\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: null,
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 4,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });

    describe('Given `[a]key=v` (no gap after the bracket), When tokenizeConfig', () => {
      it('Then the shared-line entry starts right after the bracket and records a.key = v', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const tokens = sut('[a]key=v\n');
        const sections = parseIniSections('[a]key=v\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'v',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 3,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a]\\tkey = v` (TAB gap after the bracket), When parseIniSections', () => {
      it('Then a.key = v is recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\tkey = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a "s"] key = v` (subsectioned header + same-line entry), When tokenizeConfig', () => {
      it('Then the shared-line entry starts past the closing quote+bracket and records a.s.key = v', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const tokens = sut('[a "s"] key = v\n');
        const sections = parseIniSections('[a "s"] key = v\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', 's', 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'v',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 8,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: 's', entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a]key` (no gap, valueless), When parseIniSections', () => {
      it('Then a.key valueless is recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]key\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });

    describe('Given `[a] key=` (empty value), When parseIniSections', () => {
      it('Then a.key records the empty string distinct from valueless', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a] key=\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: '' }] },
        ]);
      });
    });

    describe('Given `[a] key = v\\n\\tk2 = v2` (same-line entry then a following entry), When parseIniSections', () => {
      it('Then both a.key = v and a.k2 = v2 are recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a] key = v\n\tk2 = v2\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          {
            section: 'a',
            subsection: undefined,
            entries: [
              { key: 'key', value: 'v' },
              { key: 'k2', value: 'v2' },
            ],
          },
        ]);
      });
    });

    describe('Given `[a] key = a=b` (first `=` splits, rest is value), When parseIniSections', () => {
      it('Then a.key records the value a=b', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a] key = a=b\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'a=b' }] },
        ]);
      });
    });

    describe('Given `[a]  key  =  v` (surrounding spaces), When parseIniSections', () => {
      it('Then a.key = v is recorded with the value trimmed', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]  key  =  v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a] key = one\\\\\\n  two` (same-line continuation), When tokenizeConfig', () => {
      it('Then the shared-line entry spans onto the next physical line with value one␣␣two', () => {
        // Arrange
        const sut = tokenizeConfig;
        const input = '[a] key = one\\\n  two\n';

        // Act
        const tokens = sut(input);
        const sections = parseIniSections(input);

        // Assert — endLine crosses the physical line boundary
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          {
            kind: 'entry',
            key: 'key',
            value: 'one  two',
            startLine: 0,
            endLine: 2,
            sharesHeaderLine: true,
            startCol: 4,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'one  two' }] },
        ]);
      });
    });

    describe('Given `[a] key = v\\r` (CRLF line), When parseIniSections', () => {
      it('Then a.key = v is recorded ignoring the trailing CR', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a] key = v\r\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: 'v' }] },
        ]);
      });
    });

    describe('Given `[a] # c` (same-line comment after header), When tokenizeConfig', () => {
      it('Then only the header token is emitted with no entry', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const tokens = sut('[a] # c\n');
        const sections = parseIniSections('[a] # c\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: true },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
        ]);
      });
    });

    describe('Given `[a] ; c` (same-line semicolon comment), When tokenizeConfig', () => {
      it('Then only the header token is emitted with no entry', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const result = sut('[a] ; c\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<ConfigToken>>([
          { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: true },
        ]);
      });
    });
  });

  describe('chained section headers on one physical line', () => {
    describe('Given `[a][b]\\nx=1` (chain then body entry), When tokenizeConfig', () => {
      it('Then two header tokens at line 0 precede the body entry recorded under the last section', () => {
        // Arrange
        const sut = tokenizeConfig;
        const input = '[a][b]\nx=1\n';

        // Act
        const tokens = sut(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
          { kind: 'entry', key: 'x', value: '1', startLine: 1, endLine: 2 },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'x', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b]k=1` (chain then same-line entry, no gap), When tokenizeConfig', () => {
      it('Then the same-line entry shares the last header line and records b.k = 1', () => {
        // Arrange
        const sut = tokenizeConfig;
        const input = '[a][b]k=1\n';

        // Act
        const tokens = sut(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
          {
            kind: 'entry',
            key: 'k',
            value: '1',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 6,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a] [b] k=1` (chain with gaps then same-line entry), When parseIniSections', () => {
      it('Then b.k = 1 is recorded under the last section', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a] [b] k=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b][c] k=1` (three-header chain then same-line entry), When tokenizeConfig', () => {
      it('Then three header tokens at line 0 precede the entry recorded under the last section', () => {
        // Arrange
        const sut = tokenizeConfig;
        const input = '[a][b][c] k=1\n';

        // Act
        const tokens = sut(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
          headerToken('c', undefined, 0),
          {
            kind: 'entry',
            key: 'k',
            value: '1',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 10,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [] },
          { section: 'c', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a]\\n[b][c]\\nk=1` (header, then a chain on its own line, then a body entry), When parseIniSections', () => {
      it('Then the body entry records under the last chained section', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n[b][c]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [] },
          { section: 'c', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b "s"] k=1` (plain header chained to a subsectioned header), When tokenizeConfig', () => {
      it('Then the entry records under the subsectioned last section b.s.k = 1', () => {
        // Arrange
        const sut = tokenizeConfig;
        const input = '[a][b "s"] k=1\n';

        // Act
        const tokens = sut(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', 's', 0),
          {
            kind: 'entry',
            key: 'k',
            value: '1',
            startLine: 0,
            endLine: 1,
            sharesHeaderLine: true,
            startCol: 11,
          },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: 's', entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a "s"][b] k=1` (subsectioned header chained to a plain header), When parseIniSections', () => {
      it('Then the entry records under the plain last section b.k = 1', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a "s"][b] k=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: 's', entries: [] },
          { section: 'b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a][b]` (chain with no entry), When tokenizeConfig', () => {
      it('Then both headers are emitted as empty sections with no entry', () => {
        // Arrange
        const sut = tokenizeConfig;
        const input = '[a][b]\n';

        // Act
        const tokens = sut(input);
        const sections = parseIniSections(input);

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          headerToken('b', undefined, 0),
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
          { section: 'b', subsection: undefined, entries: [] },
        ]);
      });
    });

    describe('Given `[a][b] # c` (chain then a same-line comment), When tokenizeConfig', () => {
      it('Then both headers are emitted, the last carrying the comment flag, with no entry', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const result = sut('[a][b] # c\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<ConfigToken>>([
          { kind: 'header', section: 'a', subsection: undefined, line: 0, hasComment: false },
          { kind: 'header', section: 'b', subsection: undefined, line: 0, hasComment: true },
        ]);
      });
    });

    describe('Given `[a][b` (a valid header chained to an unclosed second span), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a][b\n', 1);
      });
    });

    describe('Given `[a][]` (a valid header chained to an empty second span), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a][]\n', 1);
      });
    });

    describe('Given `[a][ b]` (a valid header chained to an interior-whitespace second span), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a][ b]\n', 1);
      });
    });
  });

  describe('the unified key grammar refuses what git refuses', () => {
    describe('Given `[a] bad!key = v` (exclamation in same-line key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a] bad!key = v\n', 1);
      });
    });

    describe('Given `[a] foo bar = v` (space inside same-line key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a] foo bar = v\n', 1);
      });
    });

    describe('Given `[a] foo.dot = v` (dot in same-line key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a] foo.dot = v\n', 1);
      });
    });

    describe('Given `\\tbad!key = v` under a header (exclamation), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tbad!key = v\n', 2);
      });
    });

    describe('Given `\\tunder_score = v` under a header (underscore), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tunder_score = v\n', 2);
      });
    });

    describe('Given `\\t9key = v` under a header (digit-first), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\t9key = v\n', 2);
      });
    });

    describe('Given `\\t-key = v` under a header (dash-first), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\t-key = v\n', 2);
      });
    });

    describe('Given `\\tkey.dot = v` under a header (dot in key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey.dot = v\n', 2);
      });
    });

    describe('Given `\\tkey@at = v` under a header (at in key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey@at = v\n', 2);
      });
    });

    describe('Given `\\tkey x = v` under a header (space then non-`=`), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey x = v\n', 2);
      });
    });
  });

  describe('the unquoted section-name grammar accepts what git accepts', () => {
    describe('Given `[1a]` (digit-first section, unlike keys), When parseIniSections', () => {
      it('Then the section records as 1a', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[1a]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '1a', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a.b]` (dot in section), When parseIniSections', () => {
      it('Then the section records as a.b', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a.b]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a.b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a-b]` (dash in section), When parseIniSections', () => {
      it('Then the section records as a-b', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a-b]\nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a-b', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });

    describe('Given `[a] ` (trailing space after the bracket), When parseIniSections', () => {
      it('Then the section records as a with the trailing gap ignored', () => {
        // Arrange — a gap after `]` is fine; only whitespace INSIDE the brackets refuses
        const sut = parseIniSections;

        // Act
        const result = sut('[a] \nk=1\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: '1' }] },
        ]);
      });
    });
  });

  describe('the unquoted section-name grammar refuses what git refuses', () => {
    describe('Given `[a ]` (whitespace before the close), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a ]\nk=1\n', 1);
      });
    });

    describe('Given `[ a]` (whitespace after the open), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[ a]\nk=1\n', 1);
      });
    });

    describe('Given `[a b]` (interior whitespace), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a b]\nk=1\n', 1);
      });
    });

    describe('Given `[ core ]` (padded section name), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[ core ]\nk=1\n', 1);
      });
    });

    describe('Given `[a_b]` (underscore in section, outside the grammar), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a_b]\nk=1\n', 1);
      });
    });
  });

  describe('the unified key grammar accepts what git accepts', () => {
    describe('Given `\\tk = v` under a header, When parseIniSections', () => {
      it('Then a.k = v is recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `\\tk   = v` under a header (spaces before `=`), When parseIniSections', () => {
      it('Then a.k = v is recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk   = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `\\tk\\t= v` under a header (TAB before `=`), When parseIniSections', () => {
      it('Then a.k = v is recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk\t= v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `\\tkey   ` under a header (trailing spaces, no `=`), When parseIniSections', () => {
      it('Then a.key valueless is recorded', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tkey   \n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'key', value: null }] },
        ]);
      });
    });
  });

  describe('orphan (sectionless) keys', () => {
    describe('Given `orphan = v` before any header, When parseIniSections', () => {
      it('Then it records under the empty section with no subsection', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('orphan = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '', subsection: undefined, entries: [{ key: 'orphan', value: 'v' }] },
        ]);
      });
    });

    describe('Given `orphan` (valueless) before any header, When parseIniSections', () => {
      it('Then it records valueless under the empty section', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('orphan\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '', subsection: undefined, entries: [{ key: 'orphan', value: null }] },
        ]);
      });
    });

    describe('Given `orphan = v\\n[a]\\n\\tk = w` (orphan then a section), When parseIniSections', () => {
      it('Then the orphan section precedes the named section', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('orphan = v\n[a]\n\tk = w\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: '', subsection: undefined, entries: [{ key: 'orphan', value: 'v' }] },
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'w' }] },
        ]);
      });
    });

    describe('Given a header-only file, When parseIniSections', () => {
      it('Then no empty orphan section is emitted', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given `bad!orphan = v` before any header, When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('bad!orphan = v\n', 1);
      });
    });

    describe('Given `9orphan = v` before any header, When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 1', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('9orphan = v\n', 1);
      });
    });

    describe('Given the three empty-section identities, When qualifyKey', () => {
      it('Then an orphan (undefined subsection) renders the bare key with no dot', () => {
        // Arrange
        const sut = qualifyKey;

        // Act
        const result = sut({ section: '', subsection: undefined, entries: [] }, 'Key');

        // Assert
        expect(result).toBe('key');
      });

      it('Then an empty section with an empty subsection renders both dots before the key', () => {
        // Arrange
        const sut = qualifyKey;

        // Act
        const result = sut({ section: '', subsection: '', entries: [] }, 'Key');

        // Assert
        expect(result).toBe('..key');
      });

      it('Then a named empty-section subsection renders .subsection.key', () => {
        // Arrange
        const sut = qualifyKey;

        // Act
        const result = sut({ section: '', subsection: 'x', entries: [] }, 'Key');

        // Assert
        expect(result).toBe('.x.key');
      });
    });

    describe('Given the orphan key `orphan`, When parseConfigKey', () => {
      it('Then it is unaddressable — CONFIG_KEY_INVALID with reason missing-name', () => {
        // Arrange
        const sut = parseConfigKey;

        // Act + Assert
        try {
          sut('orphan');
          expect.unreachable('orphan key must be unaddressable');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CONFIG_KEY_INVALID');
          if (err.data.code === 'CONFIG_KEY_INVALID') {
            expect(err.data.reason).toBe('missing-name');
          }
        }
      });
    });
  });

  describe('mid-key and comment preservation forms', () => {
    describe('Given `\\tab#cd = x` under a header (hash inside the key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tab#cd = x\n', 2);
      });
    });

    describe('Given `\\tab;cd = x` under a header (semicolon inside the key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tab;cd = x\n', 2);
      });
    });

    describe('Given `\\tab # cd = x` under a header (space-hash inside the key), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tab # cd = x\n', 2);
      });
    });

    describe('Given `\\tkey#=v` under a header (hash before the `=`), When parseIniSections', () => {
      it('Then CONFIG_PARSE_ERROR carries line 2', () => {
        // Arrange + Act + Assert
        assertParseConfigRefuses('[a]\n\tkey#=v\n', 2);
      });
    });

    describe('Given `\\t#whole = line` under a header (whole-line comment), When tokenizeConfig', () => {
      it('Then it is a comment token and no entry records', () => {
        // Arrange
        const sut = tokenizeConfig;

        // Act
        const tokens = sut('[a]\n\t#whole = line\n');
        const sections = parseIniSections('[a]\n\t#whole = line\n');

        // Assert
        expect(tokens).toEqual<ReadonlyArray<ConfigToken>>([
          headerToken('a', undefined, 0),
          { kind: 'comment', line: 1 },
        ]);
        expect(sections).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [] },
        ]);
      });
    });

    describe('Given `\\tk = v # trailing` under a header (value-side comment), When parseIniSections', () => {
      it('Then a.k = v is recorded with the comment dropped', () => {
        // Arrange
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk = v # trailing\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });
  });

  describe('key-scanner guard isolation', () => {
    describe('Given a first character that is not a letter, When parseIniSections', () => {
      it('Then the digit-first key alone refuses on its physical line', () => {
        // Arrange + Act + Assert — isolates the first-char-alpha guard
        assertParseConfigRefuses('[a]\n\t1 = v\n', 2);
      });
    });

    describe('Given a key followed by spaces then `=` (`k   =`), When parseIniSections', () => {
      it('Then the space run is skipped and a.k = v is recorded', () => {
        // Arrange — isolates the post-key space skip on the `=` branch
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk   = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given a key followed by a TAB then `=` (`k\\t=`), When parseIniSections', () => {
      it('Then the TAB is skipped and a.k = v is recorded', () => {
        // Arrange — isolates the post-key TAB skip on the `=` branch
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk\t= v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });
    });

    describe('Given the post-key terminator branches, When parseIniSections', () => {
      it('Then a bare EOL records a valueless entry', () => {
        // Arrange — isolates the EOL branch
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: null }] },
        ]);
      });

      it('Then a CR-at-EOL records a valueless entry', () => {
        // Arrange — isolates the CR-at-EOL branch
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk\r\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: null }] },
        ]);
      });

      it('Then an `=` records a valued entry', () => {
        // Arrange — isolates the `=` branch
        const sut = parseIniSections;

        // Act
        const result = sut('[a]\n\tk = v\n');

        // Assert
        expect(result).toEqual<ReadonlyArray<IniSection>>([
          { section: 'a', subsection: undefined, entries: [{ key: 'k', value: 'v' }] },
        ]);
      });

      it('Then any other char after the key refuses', () => {
        // Arrange + Act + Assert — isolates the catch-all parse-error branch
        assertParseConfigRefuses('[a]\n\tk: v\n', 2);
      });
    });
  });
});

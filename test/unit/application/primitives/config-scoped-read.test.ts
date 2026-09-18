import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  invalidateConfigCache,
} from '../../../../src/application/primitives/config-read.js';
import {
  __resetSectionsCacheForTests,
  getConfigValue,
  invalidateScopedConfigCache,
  isWorktreeScopeActive,
} from '../../../../src/application/primitives/config-scoped-read.js';
import { permissionDenied } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileSystem } from '../../../../src/ports/file-system.js';
import { instrumentedContext } from './fixtures.js';

const u8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const withFsOverride = (ctx: Context, overrides: Partial<FileSystem>): Context => ({
  ...ctx,
  fs: { ...ctx.fs, ...overrides } as FileSystem,
});

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

const configPathOf = (ctx: Context): string => `${ctx.layout.gitDir}/config`;

/**
 * Wraps `ctx.fs.stat` so a call against the local config path always
 * returns the FROZEN stat captured before this call, regardless of any
 * write that lands on it afterwards — deterministically simulating a
 * same-tick, same-size external rewrite a real clock's millisecond
 * resolution might or might not happen to reproduce. Mirrors
 * `read-index.test.ts`'s `withFrozenStat`.
 */
const withFrozenConfigStat = async (ctx: Context): Promise<Context> => {
  const path = configPathOf(ctx);
  const frozen = await ctx.fs.stat(path);
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      stat: async (p: string) => (p === path ? frozen : ctx.fs.stat(p)),
    },
  };
};

describe('primitives/config-scoped-read', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  // Pins the corrected contract: `invalidateConfigCache` DELEGATES to
  // `invalidateScopedConfigCache`, so calling it alone is enough to drop the
  // scoped cache too — an embedder unaware of the second cache, or test code
  // seeding via a raw fs write plus a single invalidator call, still
  // observes a fresh scoped read. Every writer also calls both explicitly
  // (see `update-config.ts`/`update-config-sections.ts`); that path remains
  // useful on its own (dropping the scoped cache without touching the parse
  // cache), just no longer required for THIS contract.
  //
  // The stat is deliberately FROZEN (`withFrozenConfigStat`), not left to a
  // real rewrite's real mtime: mtime+size staleness detection WOULD catch an
  // ordinary same-size rewrite most of the time, since two sequential writes
  // rarely land in the exact same clock tick — making a test that relies on
  // real timing flaky rather than deterministic. Freezing the stat pins the
  // one case detection genuinely cannot help with (a same-tick, same-size
  // external rewrite — see `scopeFileMtimeKey`'s own docstring), for which
  // an explicit invalidator remains the only signal.
  describe('Given a scoped value cached, and the config file rewritten under a frozen (same-tick) stat', () => {
    describe('When invalidateConfigCache runs alone', () => {
      it('Then the next scoped read sees the new value — invalidateConfigCache delegates to invalidateScopedConfigCache', async () => {
        // Arrange
        const base = createMemoryContext();
        await seed(base, '[user]\n\tname = ada\n');
        const ctx = await withFrozenConfigStat(base);
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(base, '[user]\n\tname = bob\n');

        // Act
        invalidateConfigCache(ctx);
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'bob', scope: 'local' });
      });
    });

    describe('When invalidateScopedConfigCache also runs (the explicit pairing every writer still uses)', () => {
      it('Then the next scoped read sees the new value', async () => {
        // Arrange
        const base = createMemoryContext();
        await seed(base, '[user]\n\tname = ada\n');
        const ctx = await withFrozenConfigStat(base);
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(base, '[user]\n\tname = bob\n');

        // Act
        invalidateConfigCache(ctx);
        invalidateScopedConfigCache(ctx);
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'bob', scope: 'local' });
      });
    });
  });

  describe('Given a scoped value cached for one worktree Context, and a sibling worktree Context (same session, different gitDir) writes global config under a frozen stat', () => {
    describe('When the sibling calls invalidateConfigCache and Context A reads the scope again', () => {
      it("Then Context A sees the new value — invalidateScopedConfigCache drops every gitDir bucket for the session, not just the caller's own", async () => {
        // Arrange — two Contexts sharing one session and one commonDir (so
        // the LOCAL scope is the SAME physical file) but distinct gitDirs —
        // the shape a repository's linked worktrees take.
        const base = createMemoryContext();
        await seed(base, '[user]\n\tname = ada\n');
        const ctxA = await withFrozenConfigStat(base);
        const ctxB: Context = {
          ...base,
          layout: {
            ...base.layout,
            gitDir: `${base.layout.gitDir}-sibling`,
            commonDir: base.layout.gitDir,
          },
        };
        await getConfigValue({ ctx: ctxA, key: 'user.name', scope: 'local' });
        await seed(base, '[user]\n\tname = bob\n');

        // Act — invalidation runs through the SIBLING Context, not ctxA.
        invalidateConfigCache(ctxB);
        const result = await getConfigValue({ ctx: ctxA, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'bob', scope: 'local' });
      });
    });
  });

  describe('Given a scoped value cached, and the config file rewritten to a different size on disk — via raw fs.writeUtf8, no invalidator called', () => {
    describe('When the next scoped read runs', () => {
      it('Then it sees the new value — mtime+size staleness detection catches the rewrite on its own', async () => {
        // Arrange — closes the same latent-bug class `config-read.ts`'s
        // `cache` closes: a raw write past both invalidators (the pattern
        // most tests, and some production call sites, use to seed/mutate
        // config) must still be observed on the next read, not served
        // forever from a session/gitDir-keyed cache with no freshness
        // check of its own.
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n\tname = ada\n');
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(ctx, '[user]\n\tname = a-much-longer-value\n');

        // Act — deliberately no invalidateConfigCache/invalidateScopedConfigCache.
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'a-much-longer-value', scope: 'local' });
      });
    });
  });

  describe('Given an unscoped config.get with the worktree extension active', () => {
    describe('When getConfigValue merges every scope', () => {
      it('Then the local config file is read exactly once — isWorktreeScopeActive shares the cached local read', async () => {
        // Arrange — today's raw, uncached isWorktreeScopeActive read of the
        // SAME local file, on top of the cached scope="local" read, would
        // make this two.
        const base = createMemoryContext();
        await seed(base, '[extensions]\n\tworktreeConfig = true\n');
        const { ctx, calls } = instrumentedContext(base);

        // Act
        await getConfigValue({ ctx, key: 'user.name' });

        // Assert
        const localReads = calls().filter(
          (c) => c.method === 'readUtf8' && c.path === `${ctx.layout.gitDir}/config`,
        );
        expect(localReads).toHaveLength(1);
      });
    });
  });
});

describe('isWorktreeScopeActive', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given a local config in a given state', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it.each([
        {
          label: '[extensions] worktreeConfig = true',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = true\n') },
          expected: true,
        },
        {
          label: 'the worktreeConfig key is absent',
          files: { '/repo/.git/config': u8('[user]\n\tname = ada\n') },
          expected: false,
        },
        {
          label: 'no local config exists at all (missing file is not an error)',
          files: {},
          expected: false,
        },
        {
          label: 'worktreeConfig = true sits under a non-[extensions] section',
          files: { '/repo/.git/config': u8('[user]\n\tworktreeConfig = true\n') },
          expected: false,
        },
        {
          label: 'worktreeConfig = true sits under a subsectioned [extensions "x"]',
          files: { '/repo/.git/config': u8('[extensions "x"]\n\tworktreeConfig = true\n') },
          expected: false,
        },
        {
          label: '[extensions] carries a different key set to true',
          files: { '/repo/.git/config': u8('[extensions]\n\totherKey = true\n') },
          expected: false,
        },
        {
          label: '[extensions] worktreeConfig = false (boolean-false word)',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = false\n') },
          expected: false,
        },
        {
          label:
            '[extensions] worktreeConfig = maybe (grammar-refused — inert HERE; the discovery gate raises it)',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = maybe\n') },
          expected: false,
        },
        {
          label: '[extensions] worktreeConfig = TRUE (case-insensitive word)',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = TRUE\n') },
          expected: true,
        },
        {
          label: '[extensions] worktreeConfig = yes',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = yes\n') },
          expected: true,
        },
        {
          label: '[extensions] worktreeConfig = on',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = on\n') },
          expected: true,
        },
        {
          label: '[extensions] worktreeConfig = 1',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = 1\n') },
          expected: true,
        },
        {
          label: '[extensions] worktreeConfig = 2 (integer-true, magnitude arm)',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = 2\n') },
          expected: true,
        },
        {
          label: '[extensions] worktreeConfig (valueless — git’s internal NULL, always true)',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig\n') },
          expected: true,
        },
        {
          label: '[extensions] worktreeConfig = off',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = off\n') },
          expected: false,
        },
        {
          label: '[extensions] worktreeConfig = 0',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = 0\n') },
          expected: false,
        },
        {
          label: '[extensions] worktreeConfig = "" (empty value)',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = ""\n') },
          expected: false,
        },
      ])('Then returns $expected ($label)', async ({ files, expected }) => {
        // Arrange
        const ctx = createMemoryContext({ files });

        // Act
        const result = await isWorktreeScopeActive(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the local config read rejects with PERMISSION_DENIED', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then it reports inactive — the shared scoped reader treats a permission-denied scope as absent', async () => {
        // Arrange — isWorktreeScopeActive now routes through readSingleScope,
        // which treats PERMISSION_DENIED the same as FILE_NOT_FOUND (empty
        // config), unlike the raw, uncached read this predicate used to do.
        const original = permissionDenied('/repo/.git/config');
        const ctx = withFsOverride(createMemoryContext(), {
          readUtf8: () => Promise.reject(original),
        });

        // Act
        const result = await isWorktreeScopeActive(ctx);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the local config read rejects with a non-TsgitError', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then the error propagates unchanged', async () => {
        // Arrange
        const original = new Error('disk on fire');
        const ctx = withFsOverride(createMemoryContext(), {
          readUtf8: () => Promise.reject(original),
        });
        let caught: unknown;

        // Act
        try {
          await isWorktreeScopeActive(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(original);
      });
    });
  });

  describe('Given a layout the ownership-trust gate refused', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then it reports inactive without reading the config file', async () => {
        // Arrange — the invariant it has to hold up is that a refused
        // repository's config is never PARSED, so the assertion is on the
        // read, not just the verdict.
        const base = createMemoryContext();
        await base.fs.writeUtf8(
          `${base.layout.gitDir}/config`,
          '[extensions]\n\tworktreeConfig = true\n',
        );
        let reads = 0;
        const ctx = {
          ...base,
          fs: {
            ...base.fs,
            readUtf8: async (path: string) => {
              reads += 1;
              return base.fs.readUtf8(path);
            },
          },
          layout: { ...base.layout, untrusted: true as const },
        };

        // Act
        const result = await isWorktreeScopeActive(ctx);

        // Assert
        expect(result).toBe(false);
        expect(reads).toBe(0);
      });
    });
  });

  describe('Given a layout refused for an unsupported repository format', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then it reports inactive without reading the config file', async () => {
        // Arrange — the trust half of this guard is pinned by the sibling
        // above; this is the format half. The planted extension makes both
        // oracles discriminating: an unguarded read parses
        // `worktreeConfig = true` and returns true.
        const base = createMemoryContext();
        await base.fs.writeUtf8(
          `${base.layout.gitDir}/config`,
          '[extensions]\n\tworktreeConfig = true\n',
        );
        let reads = 0;
        const ctx = {
          ...base,
          fs: {
            ...base.fs,
            readUtf8: async (path: string) => {
              reads += 1;
              return base.fs.readUtf8(path);
            },
          },
          layout: {
            ...base.layout,
            formatRefusal: { kind: 'version' as const, version: 99 },
          },
        };

        // Act
        const result = await isWorktreeScopeActive(ctx);

        // Assert
        expect(result).toBe(false);
        expect(reads).toBe(0);
      });
    });
  });
});

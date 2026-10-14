import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { status } from '../../../../src/application/commands/status.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const T = 1_800_000_000_000;
const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const at = (offsetSeconds: number): void => {
  vi.setSystemTime(T + offsetSeconds * 1000);
};

/** Files a and b written at T, added and committed at T+2s: a settled repository. */
const seedSettled = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  at(0);
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
  at(2);
  await add(ctx, ['a.txt', 'b.txt']);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

const indexRenames = (ctx: Context) => {
  const spy = vi.spyOn(ctx.fs, 'rename');
  return () =>
    spy.mock.calls.filter(
      ([from, to]) =>
        String(from) === `${ctx.layout.gitDir}/index.lock` &&
        String(to) === `${ctx.layout.gitDir}/index`,
    ).length;
};

const entryOf = async (ctx: Context, path: string) => {
  invalidateIndexCache(ctx);
  const index = await readIndex(ctx);
  return index.entries.find((e) => e.path === (path as FilePath));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status refresh write-back', () => {
  describe('Given a settled repo with file b rewritten with the same bytes at T+5s', () => {
    describe('When status runs at T+7s', () => {
      it('Then the index is rewritten once and b carries the new mtime with the same id', async () => {
        // Arrange
        const ctx = await seedSettled();
        const before = await entryOf(ctx, 'b.txt');
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        at(7);
        const renames = indexRenames(ctx);

        // Act
        const sut = status;
        const result = await sut(ctx);

        // Assert
        const after = await entryOf(ctx, 'b.txt');
        expect(result.clean).toBe(true);
        expect(renames()).toBe(1);
        expect(after?.id).toBe(before?.id);
        expect(after?.mtimeSeconds).toBe(T / 1000 + 5);
      });
    });
  });
});

describe('status racy write-back', () => {
  describe('Given an entry whose mtime is in the same second as the index and unchanged content', () => {
    describe('When status runs later', () => {
      it('Then the index is rewritten', async () => {
        // Arrange
        const ctx = createMemoryContext();
        at(0);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        at(3);
        const renames = indexRenames(ctx);

        // Act
        await status(ctx);

        // Assert
        expect(renames()).toBe(1);
      });
    });
  });
});

const lockPathOf = (ctx: Context): string => `${ctx.layout.gitDir}/index.lock`;
const indexPathOf = (ctx: Context): string => `${ctx.layout.gitDir}/index`;

const rewriteB = async (ctx: Context): Promise<void> => {
  at(5);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
  at(7);
};

describe('status nothing to persist', () => {
  describe('Given a settled repo where nothing moved', () => {
    describe('When status runs at a later second', () => {
      it('Then the index is not rewritten and no lock is left', async () => {
        // Arrange
        const ctx = await seedSettled();
        at(9);
        const renames = indexRenames(ctx);

        // Act
        await status(ctx);

        // Assert
        expect(renames()).toBe(0);
        expect(await ctx.fs.exists(lockPathOf(ctx))).toBe(false);
      });
    });
  });

  describe('Given a settled repo where a file changed content', () => {
    describe('When status runs', () => {
      it('Then the change is reported and the index is not rewritten', async () => {
        // Arrange
        const ctx = await seedSettled();
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'B!');
        at(7);
        const renames = indexRenames(ctx);

        // Act
        const sut = status;
        const result = await sut(ctx);

        // Assert
        expect(result.changes.map((c) => c.path)).toEqual(['b.txt']);
        expect(renames()).toBe(0);
      });
    });
  });
});

describe('status result stability', () => {
  describe('Given a stat-moved file', () => {
    describe('When status runs twice and once more with the lock pre-created', () => {
      it('Then all three results deep-equal', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);

        // Act
        const first = await status(ctx);
        const second = await status(ctx);
        await ctx.fs.writeUtf8(lockPathOf(ctx), '');
        const locked = await status(ctx);

        // Assert
        expect(second).toEqual(first);
        expect(locked).toEqual(first);
      });
    });
  });
});

describe('status with a held index lock', () => {
  describe('Given index.lock already exists and a stat-moved file', () => {
    describe('When status runs', () => {
      it('Then it returns, writes nothing and leaves the lock bytes untouched', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);
        await ctx.fs.writeUtf8(lockPathOf(ctx), 'held');
        const warn = vi.fn();
        const logged = { ...ctx, logger: { warn } } as Context;
        const renames = indexRenames(ctx);

        // Act
        const sut = status;
        const result = await sut(logged);

        // Assert
        expect(result.clean).toBe(true);
        expect(renames()).toBe(0);
        expect(await ctx.fs.readUtf8(lockPathOf(ctx))).toBe('held');
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('status when the index moves under the lock', () => {
  describe('Given an add through the same fs inside the lock acquisition', () => {
    describe('When status would write back', () => {
      it('Then status writes nothing and leaves no lock', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);
        const base = ctx.fs;
        let moved = false;
        const fs = new Proxy(base, {
          get(target, prop, receiver) {
            const original = Reflect.get(target, prop, receiver);
            if (prop !== 'writeExclusive') return original;
            return async (path: string, ...rest: unknown[]) => {
              await original.call(target, path, ...rest);
              if (moved || !String(path).endsWith('index.lock')) return;
              moved = true;
              await base.rm(path);
              await base.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
              await add({ ...ctx, fs: base } as Context, ['c.txt']);
              await original.call(target, path, ...rest);
            };
          },
        });
        const sutCtx = { ...ctx, fs } as Context;
        const staleMtime = (await entryOf(ctx, 'b.txt'))?.mtimeSeconds;

        // Act
        await status(sutCtx);

        // Assert
        expect(moved).toBe(true);
        expect((await entryOf(ctx, 'c.txt'))?.path).toBe('c.txt');
        expect((await entryOf(ctx, 'b.txt'))?.mtimeSeconds).toBe(staleMtime);
        expect(await ctx.fs.exists(lockPathOf(ctx))).toBe(false);
      });
    });
  });
});

describe('status refusals with the lock taken', () => {
  describe('Given a malformed core.warnAmbiguousRefs', () => {
    describe('When status runs', () => {
      it('Then it refuses with the setting data and leaves no lock', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `${config}[core]\n\twarnAmbiguousRefs = maybe\n`,
        );
        __resetConfigCacheForTests();

        // Act
        const refusal = await status(ctx).catch((err: TsgitError) => err.data);

        // Assert
        expect(refusal).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'core.warnambiguousrefs',
          value: 'maybe',
        });
        expect(await ctx.fs.exists(lockPathOf(ctx))).toBe(false);
      });
    });
  });

  describe('Given a corrupt index', () => {
    describe('When status runs', () => {
      it('Then it refuses with the index data and never takes the lock', async () => {
        // Arrange
        const ctx = await seedSettled();
        await ctx.fs.writeUtf8(indexPathOf(ctx), 'corrupt');
        invalidateIndexCache(ctx);
        const exclusive = vi.spyOn(ctx.fs, 'writeExclusive');

        // Act
        const refusal = await status(ctx).catch((err: TsgitError) => err.data);

        // Assert
        expect(refusal).toMatchObject({ code: 'INVALID_INDEX_HEADER' });
        expect(exclusive).not.toHaveBeenCalled();
      });
    });
  });
});

describe('status in a fresh repo', () => {
  describe('Given no index file', () => {
    describe('When status runs', () => {
      it('Then neither index nor index.lock exists afterwards', async () => {
        // Arrange
        const ctx = createMemoryContext();
        at(0);
        await init(ctx);

        // Act
        await status(ctx);

        // Assert
        expect(await ctx.fs.exists(indexPathOf(ctx))).toBe(false);
        expect(await ctx.fs.exists(lockPathOf(ctx))).toBe(false);
      });
    });
  });
});

const withEnv = (ctx: Context, vars: Record<string, string>): Context =>
  ({ ...ctx, env: { get: (name: string) => vars[name] } }) as Context;

describe('status refresh option', () => {
  describe('Given a stat-moved tracked file', () => {
    describe('When status runs with refresh false', () => {
      it('Then the index is not rewritten and writeExclusive was never called', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);
        const renames = indexRenames(ctx);
        const exclusive = vi.spyOn(ctx.fs, 'writeExclusive');

        // Act
        const sut = status;
        const result = await sut(ctx, { refresh: false });

        // Assert
        expect(result.clean).toBe(true);
        expect(renames()).toBe(0);
        expect(exclusive).not.toHaveBeenCalled();
      });
    });
  });
});

describe('status GIT_OPTIONAL_LOCKS', () => {
  describe.each(['0', 'false', 'off', ''])(
    'Given GIT_OPTIONAL_LOCKS=%j and a stat-moved file',
    (value) => {
      describe('When status runs', () => {
        it('Then no lock is taken and the index is not rewritten', async () => {
          // Arrange
          const ctx = await seedSettled();
          await rewriteB(ctx);
          const renames = indexRenames(ctx);
          const exclusive = vi.spyOn(ctx.fs, 'writeExclusive');

          // Act
          await status(withEnv(ctx, { GIT_OPTIONAL_LOCKS: value }));

          // Assert
          expect(exclusive).not.toHaveBeenCalled();
          expect(renames()).toBe(0);
        });
      });
    },
  );

  describe.each(['2', 'yes'])('Given GIT_OPTIONAL_LOCKS=%j and a stat-moved file', (value) => {
    describe('When status runs', () => {
      it('Then the index is rewritten once', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);
        const renames = indexRenames(ctx);

        // Act
        await status(withEnv(ctx, { GIT_OPTIONAL_LOCKS: value }));

        // Assert
        expect(renames()).toBe(1);
      });
    });
  });

  describe('Given GIT_OPTIONAL_LOCKS=bogus', () => {
    describe('When status runs', () => {
      it('Then it refuses with the variable data and leaves no lock', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);

        // Act
        const refusal = await status(withEnv(ctx, { GIT_OPTIONAL_LOCKS: 'bogus' })).catch(
          (err: TsgitError) => err.data,
        );

        // Assert
        expect(refusal).toMatchObject({
          code: 'ENV_BAD_BOOLEAN_VALUE',
          variable: 'GIT_OPTIONAL_LOCKS',
          value: 'bogus',
        });
        expect(await ctx.fs.exists(lockPathOf(ctx))).toBe(false);
      });
    });
  });

  describe('Given GIT_OPTIONAL_LOCKS=0 and refresh true', () => {
    describe('When status runs', () => {
      it('Then the env still disables the write', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);
        const renames = indexRenames(ctx);

        // Act
        await status(withEnv(ctx, { GIT_OPTIONAL_LOCKS: '0' }), { refresh: true });

        // Assert
        expect(renames()).toBe(0);
      });
    });
  });

  describe('Given GIT_OPTIONAL_LOCKS=bogus and refresh false', () => {
    describe('When status runs', () => {
      it('Then the option short-circuits before the env and no refusal occurs', async () => {
        // Arrange
        const ctx = await seedSettled();
        await rewriteB(ctx);

        // Act
        const sut = status;
        const result = await sut(withEnv(ctx, { GIT_OPTIONAL_LOCKS: 'bogus' }), { refresh: false });

        // Assert
        expect(result.clean).toBe(true);
      });
    });
  });
});

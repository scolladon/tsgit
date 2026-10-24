import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import {
  scanTrackedEntries,
  verifiedBy,
} from '../../../../../src/application/primitives/internal/scan-tracked-entries.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../../src/application/primitives/read-index.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const T = 1_800_000_000_000;
const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const A = 'a.txt' as FilePath;
const B = 'b.txt' as FilePath;

const at = (offsetSeconds: number): void => {
  vi.setSystemTime(T + offsetSeconds * 1000);
};

const seedSettled = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  at(0);
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${A}`, 'a');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${B}`, 'b');
  at(2);
  await add(ctx, [A, B]);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

const freshIndex = async (ctx: Context) => {
  invalidateIndexCache(ctx);
  return readIndex(ctx);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scanTrackedEntries', () => {
  describe('Given two committed files sharing a directory', () => {
    describe('When scanning the tracked entries', () => {
      it('Then the directory is lstat-ed once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        at(0);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d/a`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d/b`, 'b');
        at(2);
        await add(ctx, ['d/a', 'd/b']);
        await commit(ctx, { message: 'first', author });
        const index = await freshIndex(ctx);
        const spy = vi.spyOn(ctx.fs, 'lstat');
        const sut = scanTrackedEntries;

        // Act
        await sut(ctx, index, index.entries, () => {});

        // Assert
        const directory = `${ctx.layout.workDir}/d`;
        expect(spy.mock.calls.filter(([p]) => p === directory)).toHaveLength(1);
      });
    });
  });

  describe('Given a committed file rewritten with the same bytes at a newer mtime', () => {
    describe('When scanning the tracked entries', () => {
      it('Then it is refreshed with the new stat and reported unchanged', async () => {
        // Arrange
        const ctx = await seedSettled();
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${B}`, 'b');
        at(7);
        const index = await freshIndex(ctx);
        const sut = scanTrackedEntries;

        // Act
        const result = await sut(ctx, index, index.entries, () => {});

        // Assert
        expect(result.refreshed.map((entry) => entry.path)).toEqual([B]);
        expect(result.refreshed[0]?.mtimeSeconds).toBe(T / 1000 + 5);
        expect(result.workingMap.get(B)?.status).toBe('unchanged');
      });
    });
  });

  describe('Given a skip-worktree entry whose file drifted', () => {
    describe('When scanning the tracked entries', () => {
      it('Then it is neither mapped nor refreshed, and every entry is still ticked', async () => {
        // Arrange
        const ctx = await seedSettled();
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${B}`, 'b');
        at(7);
        const index = await freshIndex(ctx);
        const entries = index.entries.map((entry) =>
          entry.path === B ? { ...entry, flags: { ...entry.flags, skipWorktree: true } } : entry,
        );
        const onScanned = vi.fn();
        const sut = scanTrackedEntries;

        // Act
        const result = await sut(ctx, index, entries, onScanned);

        // Assert
        expect(result.workingMap.has(B)).toBe(false);
        expect(result.refreshed).toEqual([]);
        expect(onScanned).toHaveBeenCalledTimes(entries.length);
      });
    });
  });
});

describe('scanTrackedEntries stat cache and clean order', () => {
  describe('Given a file rewritten to the same size at its recorded mtime', () => {
    describe('When scanning the tracked entries', () => {
      it('Then the armed stat cache trusts the stat and reports it unchanged', async () => {
        // Arrange
        const ctx = await seedSettled();
        at(0);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${B}`, 'x');
        at(7);
        const index = await freshIndex(ctx);
        const sut = scanTrackedEntries;

        // Act
        const result = await sut(ctx, index, index.entries, () => {});

        // Assert
        expect(index.indexMtime).toBeDefined();
        expect(result.workingMap.get(B)?.status).toBe('unchanged');
      });
    });
  });

  describe('Given a clean driver, an untouched file and a later file rewritten to the same size', () => {
    describe('When scanning the tracked entries', () => {
      it('Then the untouched path releases its turn so the later one is cleaned', async () => {
        // Arrange
        const base = await seedSettled();
        const cleaned: string[] = [];
        const command = {
          run: async (request: { readonly stdin?: Uint8Array }) => {
            cleaned.push(new TextDecoder().decode(request.stdin));
            return { exitCode: 0, stdout: request.stdin ?? new Uint8Array() };
          },
        };
        const ctx: Context = { ...base, command };
        const workDir = ctx.layout.workDir;
        await ctx.fs.writeUtf8(`${workDir}/.gitattributes`, '*.txt filter=log\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "log"]\n\tclean = log\n');
        invalidateConfigCache(ctx);
        at(5);
        await ctx.fs.writeUtf8(`${workDir}/${B}`, 'y');
        at(7);
        const index = await freshIndex(ctx);
        const sut = scanTrackedEntries;
        const watchdog = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000));

        // Act
        const result = await Promise.race([sut(ctx, index, index.entries, () => {}), watchdog]);

        // Assert
        expect(result).not.toBe('hung');
        expect(cleaned).toEqual(['y']);
      });
    });
  });
});

describe('verifiedBy', () => {
  describe('Given a scan with one unchanged and one modified path', () => {
    describe('When asking which paths are verified', () => {
      it('Then only the unchanged path is', async () => {
        // Arrange
        const ctx = await seedSettled();
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${B}`, 'changed!');
        at(7);
        const index = await freshIndex(ctx);
        const scan = await scanTrackedEntries(ctx, index, index.entries, () => {});
        const sut = verifiedBy;

        // Act
        const isVerified = sut(scan);
        const result = [isVerified(A), isVerified(B), isVerified('missing' as FilePath)];

        // Assert
        expect(result).toEqual([true, false, false]);
      });
    });
  });
});

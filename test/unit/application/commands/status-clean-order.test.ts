import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { status } from '../../../../src/application/commands/status.js';
import { withCleanOrder } from '../../../../src/application/primitives/internal/clean-order.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { stubCommandRunner } from '../primitives/helpers/stub-command-runner.js';

vi.mock(
  '../../../../src/application/primitives/internal/clean-order.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/internal/clean-order.js')
      >();
    return { ...actual, withCleanOrder: vi.fn(actual.withCleanOrder) };
  },
);

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** A runner-wired repository with one committed file, its config holding `config`. */
const seedRunnerRepository = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext({ command: stubCommandRunner() });
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author: AUTHOR });
  return ctx;
};

describe('Given a runner-wired repository that configures no filter driver', () => {
  describe('When status scans the work tree', () => {
    it('Then no clean order is opened, as no clean can run whose order shows', async () => {
      // Arrange
      const ctx = await seedRunnerRepository('[core]\n\tbare = false\n');
      vi.mocked(withCleanOrder).mockClear();
      const sut = status;

      // Act
      await sut(ctx);

      // Assert
      const result = vi.mocked(withCleanOrder).mock.calls.length;
      expect(result).toBe(0);
    });
  });
});

describe('Given a runner-wired repository that configures a filter driver', () => {
  describe('When status scans the work tree', () => {
    it('Then the scan runs inside one clean order', async () => {
      // Arrange
      const ctx = await seedRunnerRepository(
        '[core]\n\tbare = false\n[filter "up"]\n\tclean = cat\n',
      );
      vi.mocked(withCleanOrder).mockClear();
      const sut = status;

      // Act
      await sut(ctx);

      // Assert
      const result = vi.mocked(withCleanOrder).mock.calls.length;
      expect(result).toBe(1);
    });
  });
});

const LOG_DRIVER = '[core]\n\tbare = false\n[filter "log"]\n\tclean = log\n';
const SETTLE_MS = 20;
const SETTLED_EPOCH_MS = 1_800_000_000_000;
const SECOND_MS = 1000;

afterEach(() => {
  vi.useRealTimers();
});

const dec = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

interface Recorded {
  readonly ctx: Context;
  readonly cleaned: string[];
}

/** A repo committing `files`, then holding `edited` over them, whose `log` clean driver records what it hears. */
const repoUnderLogDriver = async (
  files: Readonly<Record<string, string>>,
  edited: Readonly<Record<string, string>>,
  attributes: string,
): Promise<Recorded> => {
  // The files predate the index by two seconds and the edits follow it, so no entry
  // is racy and the scan has nothing to write back: the driver hears the scan alone.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SETTLED_EPOCH_MS);
  const base = createMemoryContext();
  await init(base);
  for (const [path, content] of Object.entries(files)) {
    await base.fs.writeUtf8(`${base.layout.workDir}/${path}`, content);
  }
  vi.setSystemTime(SETTLED_EPOCH_MS + 2 * SECOND_MS);
  await add(base, Object.keys(files));
  await commit(base, { message: 'first', author: AUTHOR });
  vi.setSystemTime(SETTLED_EPOCH_MS + 5 * SECOND_MS);
  for (const [path, content] of Object.entries(edited)) {
    await base.fs.writeUtf8(`${base.layout.workDir}/${path}`, content);
  }
  await base.fs.writeUtf8(`${base.layout.workDir}/.gitattributes`, attributes);
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, LOG_DRIVER);
  const cleaned: string[] = [];
  const command = {
    run: async (request: { readonly stdin?: Uint8Array }) => {
      cleaned.push(dec(request.stdin));
      return { exitCode: 0, stdout: request.stdin ?? new Uint8Array() };
    },
  };
  return { ctx: { ...base, command }, cleaned };
};

/** Delays the stat of `slowPath`, so its read settles after every other path's. */
const withSlowLstat = (ctx: Context, slowPath: string): Context => ({
  ...ctx,
  fs: new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
      return async (path: string) => {
        if (path.endsWith(slowPath)) await new Promise((r) => setTimeout(r, SETTLE_MS));
        return target.lstat(path);
      };
    },
  }),
});

describe('Given tracked paths whose first reads slowest under a clean driver', () => {
  describe('When status scans the work tree', () => {
    it('Then the driver hears the paths in index order, not in read order', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B' },
        { 'a.txt': 'X', 'b.txt': 'Y' },
        '*.txt filter=log\n',
      );
      const sut = status;

      // Act
      await sut(withSlowLstat(ctx, '/a.txt'));

      // Assert
      expect(cleaned).toEqual(['X', 'Y']);
    });
  });
});

describe('Given a tracked path ahead of a filtered one that needs no clean', () => {
  describe('When status scans the work tree', () => {
    it('Then the filtered path is cleaned once the earlier path is done', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.dat': 'A', 'b.txt': 'B' },
        { 'a.dat': 'X', 'b.txt': 'Y' },
        '*.txt filter=log\n',
      );
      const sut = status;

      // Act
      await sut(withSlowLstat(ctx, '/a.dat'));

      // Assert
      expect(cleaned).toEqual(['Y']);
    });
  });
});

describe('Given a filter driver configured in a repository with no command runner', () => {
  describe('When status scans the work tree', () => {
    it('Then a clean order is opened, the attribute provider being built without a runner', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, LOG_DRIVER);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
      await add(ctx, ['a.txt']);
      await commit(ctx, { message: 'first', author: AUTHOR });
      vi.mocked(withCleanOrder).mockClear();
      const sut = status;

      // Act
      await sut(ctx);

      // Assert
      const result = vi.mocked(withCleanOrder).mock.calls.length;
      expect(result).toBe(1);
    });
  });
});

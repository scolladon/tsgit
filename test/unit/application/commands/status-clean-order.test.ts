import { describe, expect, it, vi } from 'vitest';
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

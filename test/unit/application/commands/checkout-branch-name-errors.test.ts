import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { validateRefName } from '../../../../src/domain/refs/index.js';

vi.mock('../../../../src/domain/refs/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/domain/refs/index.js')>();
  return { ...actual, validateRefName: vi.fn(actual.validateRefName) };
});

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const BRANCH_REF = 'refs/heads/feature';
const REFS_MODULE = '../../../../src/domain/refs/index.js';

afterEach(() => {
  vi.mocked(validateRefName).mockRestore();
});

describe('Given a branch whose ref name check fails for a reason other than its format', () => {
  describe('When checkout switches to it', () => {
    it('Then the failure surfaces instead of detaching', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
      await add(ctx, ['a.txt']);
      await commit(ctx, { message: 'first', author });
      await branchCreate(ctx, { name: 'feature' });
      const failure = new Error('ref name check failed');
      const actual =
        await vi.importActual<typeof import('../../../../src/domain/refs/index.js')>(REFS_MODULE);
      vi.mocked(validateRefName).mockImplementation((name) => {
        if (name === BRANCH_REF) throw failure;
        return actual.validateRefName(name);
      });
      const sut = checkout;

      // Act
      const result = await sut(ctx, { rev: 'feature' }).catch((error: unknown) => error);

      // Assert
      expect(result).toBe(failure);
    });
  });
});

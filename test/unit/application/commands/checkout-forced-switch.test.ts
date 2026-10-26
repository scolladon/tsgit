import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import type { AuthorIdentity, FilePath } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMITTED = 'committed\n';

const seedCommitted = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, COMMITTED);
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

describe('checkout forcing the current branch', () => {
  describe('Given a tracked file edited in the work tree', () => {
    describe('When checkout forces the current branch', () => {
      it('Then the file is rewritten to the committed content', async () => {
        // Arrange
        const ctx = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'edited!!\n');

        // Act
        await checkout(ctx, { rev: 'main', force: true });

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe(COMMITTED);
      });
    });
  });

  describe('Given stages 2-3 of a path absent from the target', () => {
    describe('When checkout forces the current branch', () => {
      it('Then the path leaves the work tree and the index', async () => {
        // Arrange
        const ctx = await seedCommitted();
        const index = await readIndex(ctx);
        const [staged] = index.entries;
        if (staged === undefined) throw new Error('nothing staged');
        const conflict = (stage: 2 | 3): IndexEntry => ({
          ...staged,
          path: 'n' as FilePath,
          flags: { ...staged.flags, stage },
        });
        const lock = await acquireIndexLock(ctx);
        await lock.commit([...index.entries, conflict(2), conflict(3)], 'replace');
        await lock.release();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/n`, 'conflicted\n');

        // Act
        await checkout(ctx, { rev: 'main', force: true });

        // Assert
        const after = await readIndex(ctx);
        expect(after.entries.map((e) => e.path)).toEqual(['a.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/n`)).toBe(false);
      });
    });
  });

  describe('Given a tracked file edited in the work tree and agreed on by HEAD, index and target', () => {
    describe('When checkout switches to the current branch without force', () => {
      it('Then the edit is kept', async () => {
        // Arrange
        const ctx = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'edited!!\n');

        // Act
        await checkout(ctx, { rev: 'main' });

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('edited!!\n');
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { recordHardReset } from '../../../../../src/application/commands/internal/reset-refs.js';
import { getRefStore } from '../../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../../src/application/primitives/reflog-store.js';
import { writeSymbolicRef } from '../../../../../src/application/primitives/write-symbolic-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const HEAD = 'HEAD' as RefName;

const seed = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
  await add(ctx, ['a.txt']);
  const head = (await commit(ctx, { message: 'first', author })).id;
  return { ctx, head };
};

describe('recordHardReset', () => {
  describe('Given an attached HEAD', () => {
    describe('When the reset records HEAD', () => {
      it('Then ORIG_HEAD names HEAD and the HEAD reflog gains one no-move entry', async () => {
        // Arrange
        const { ctx, head } = await seed();
        const before = (await readReflog(ctx, HEAD)).length;
        const sut = recordHardReset;

        // Act
        await sut(ctx, head, 'HEAD');

        // Assert
        const added = (await readReflog(ctx, HEAD)).slice(before);
        expect(added.map((e) => [e.oldId, e.newId, e.message])).toEqual([
          [head, head, 'reset: moving to HEAD'],
        ]);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(`${head}\n`);
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When the reset records HEAD', () => {
      it('Then ORIG_HEAD names HEAD and the HEAD reflog gains no entry', async () => {
        // Arrange
        const { ctx, head } = await seed();
        await getRefStore(ctx).applyRefUpdates([{ kind: 'set', name: HEAD, id: head }]);
        const before = await readReflog(ctx, HEAD);
        const sut = recordHardReset;

        // Act
        await sut(ctx, head, 'HEAD');

        // Assert
        expect(await readReflog(ctx, HEAD)).toEqual(before);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(`${head}\n`);
      });
    });
  });

  describe('Given an unborn HEAD and a stale ORIG_HEAD', () => {
    describe('When the reset records a commit', () => {
      it('Then ORIG_HEAD is removed', async () => {
        // Arrange
        const { ctx, head } = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`, `${head}\n`);
        await writeSymbolicRef(ctx, HEAD, 'refs/heads/orphan' as RefName);
        const sut = recordHardReset;

        // Act
        await sut(ctx, head, 'HEAD');

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a MERGE_HEAD standing', () => {
    describe('When the reset records HEAD', () => {
      it('Then MERGE_HEAD is removed', async () => {
        // Arrange
        const { ctx, head } = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${head}\n`);
        const sut = recordHardReset;

        // Act
        await sut(ctx, head, 'HEAD');

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });
});

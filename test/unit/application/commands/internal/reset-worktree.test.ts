import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { hardResetWorktreeToCommit } from '../../../../../src/application/commands/internal/reset-worktree.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { updateCoreConfig } from '../../../../../src/application/primitives/update-config.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const sut = hardResetWorktreeToCommit;

// Cone file: root files in, subdirs out, `/src/` back in — so `src/*` is
// in-pattern and `docs/*` is excluded. Sparse is flipped on AFTER the commit so
// both index entries start normal and the reset itself must apply the matcher.
const enableSparseSrcOnly = async (ctx: ReturnType<typeof createMemoryContext>): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/*\n!/*/\n/src/\n');
  await updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: 'true' });
};

const seedSrcAndDocs = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');
  await add(ctx, ['src/a.txt', 'docs/b.txt']);
  const c1 = await commit(ctx, { message: 'first', author });
  return { ctx, c1: c1.id };
};

describe('hardResetWorktreeToCommit', () => {
  describe('Given a dirty working tree over a committed file', () => {
    describe('When hard-reset to the commit runs', () => {
      it('Then the tracked file is restored on disk and re-indexed', async () => {
        // Arrange — commit `a`, then dirty the working copy.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const first = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty');

        // Act
        await sut(ctx, first.id);

        // Assert — content reverted and the entry is back in the index.
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a');
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'a.txt')?.id).toBeDefined();
      });
    });
  });

  describe('Given a sparse repo excluding docs/', () => {
    describe('When hard-reset to the commit runs', () => {
      it('Then the excluded path is dropped from disk and flagged skip-worktree', async () => {
        // Arrange — `src/a.txt` in-pattern, `docs/b.txt` excluded; both on disk.
        const { ctx, c1 } = await seedSrcAndDocs();
        await enableSparseSrcOnly(ctx);

        // Act
        await sut(ctx, c1);

        // Assert — the matcher must reach materializeTree: excluded `docs/b.txt`
        // is removed from disk and marked skip-worktree while `src/a.txt` stays.
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'src/a.txt')?.flags.skipWorktree).toBe(false);
        expect(index.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a commit id that resolves to a blob', () => {
    describe('When hard-reset runs', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE expecting a commit', async () => {
        // Arrange — a real blob OID that is not a commit.
        const ctx = createMemoryContext();
        await init(ctx);
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('not a commit'),
          id: '' as ObjectId,
        });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, blobId);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; expected?: string; actual?: string } })
          ?.data;
        expect(data?.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data?.expected).toBe('commit');
        expect(data?.actual).toBe('blob');
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  clearMergeState,
  readMergeHead,
  readMergeMsg,
  writeMergeHead,
  writeMergeMsg,
  writeOrigHead,
} from '../../../../../src/application/commands/internal/merge-state.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';

describe('merge-state', () => {
  describe('writeMergeHead', () => {
    it('Given a target ObjectId, When writeMergeHead is called, Then.git/MERGE_HEAD contains the id followed by a single newline', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const targetId = 'a'.repeat(40) as ObjectId;

      // Act
      await writeMergeHead(ctx, targetId);

      // Assert — exact content (not just contains), kills mutants that drop the LF.
      const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`);
      expect(sut).toBe(`${'a'.repeat(40)}\n`);
    });

    it('Given a pre-existing MERGE_HEAD, When writeMergeHead is called again, Then the file is replaced (idempotent overwrite)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const first = 'a'.repeat(40) as ObjectId;
      const second = 'b'.repeat(40) as ObjectId;

      // Act
      await writeMergeHead(ctx, first);
      await writeMergeHead(ctx, second);

      // Assert
      const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`);
      expect(sut).toBe(`${'b'.repeat(40)}\n`);
    });
  });

  describe('writeMergeMsg', () => {
    it('Given a merge message, When writeMergeMsg is called, Then.git/MERGE_MSG contains exactly the message (no trailing LF added)', async () => {
      // Arrange the message is stored verbatim, no
      // Conflicts trailer, no LF normalisation.
      const ctx = createMemoryContext();
      await init(ctx);

      // Act
      await writeMergeMsg(ctx, 'Merge branch feature');

      // Assert
      const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
      expect(sut).toBe('Merge branch feature');
    });

    it('Given a multi-line message, When writeMergeMsg is called, Then the file preserves the lines verbatim', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const message = 'Merge branch feature\n\nResolves the dep upgrade.';

      // Act
      await writeMergeMsg(ctx, message);

      // Assert
      const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
      expect(sut).toBe(message);
    });
  });

  describe('writeOrigHead', () => {
    it('Given a pre-merge HEAD id, When writeOrigHead is called, Then.git/ORIG_HEAD contains the id followed by a single newline', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const oldHead = 'c'.repeat(40) as ObjectId;

      // Act
      await writeOrigHead(ctx, oldHead);

      // Assert
      const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);
      expect(sut).toBe(`${'c'.repeat(40)}\n`);
    });
  });

  describe('readMergeHead', () => {
    it('Given no MERGE_HEAD file, When readMergeHead is called, Then returns undefined', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);

      // Act
      const sut = await readMergeHead(ctx);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a written MERGE_HEAD, When readMergeHead is called, Then returns the recorded ObjectId without the trailing newline', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const targetId = 'd'.repeat(40) as ObjectId;
      await writeMergeHead(ctx, targetId);

      // Act
      const sut = await readMergeHead(ctx);

      // Assert
      expect(sut).toBe(targetId);
    });

    it('Given a whitespace-only MERGE_HEAD, When readMergeHead is called, Then returns undefined (defensive: treats as absent)', async () => {
      // Arrange — write a file containing only whitespace.
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, '   \n');

      // Act
      const sut = await readMergeHead(ctx);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a malformed (non-hex) MERGE_HEAD, When readMergeHead is called, Then throws INVALID_OBJECT_ID with the offending value', async () => {
      // Arrange — a corrupt MERGE_HEAD (e.g., from a mid-write crash)
      // must NOT silently produce a malformed second parent. The
      // validation gate ensures `commit` cannot build a corrupt commit
      // object from poisoned state.
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, 'not-a-hex-oid\n');

      // Act
      let caught: unknown;
      try {
        await readMergeHead(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      const data = (caught as { data?: { code?: string; value?: string } })?.data;
      expect(data?.code).toBe('INVALID_OBJECT_ID');
      expect(data?.value).toBe('not-a-hex-oid');
    });
  });

  describe('readMergeMsg', () => {
    it('Given no MERGE_MSG file, When readMergeMsg is called, Then returns undefined', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);

      // Act
      const sut = await readMergeMsg(ctx);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a written MERGE_MSG, When readMergeMsg is called, Then returns the verbatim content', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await writeMergeMsg(ctx, 'Merge branch feature\nbody');

      // Act
      const sut = await readMergeMsg(ctx);

      // Assert
      expect(sut).toBe('Merge branch feature\nbody');
    });
  });

  describe('clearMergeState', () => {
    it('Given existing MERGE_HEAD and MERGE_MSG, When clearMergeState is called, Then both files are removed (ORIG_HEAD is preserved as a recovery aid)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await writeMergeHead(ctx, 'a'.repeat(40) as ObjectId);
      await writeMergeMsg(ctx, 'msg');
      await writeOrigHead(ctx, 'b'.repeat(40) as ObjectId);

      // Act
      await clearMergeState(ctx);

      // Assert — MERGE_HEAD and MERGE_MSG gone; ORIG_HEAD survives so the
      // user can `reset --hard ORIG_HEAD` after the resolved commit.
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(true);
    });

    it('Given no merge-state files, When clearMergeState is called, Then no error is thrown (idempotent)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);

      // Act / Assert
      await expect(clearMergeState(ctx)).resolves.toBeUndefined();
    });
  });
});

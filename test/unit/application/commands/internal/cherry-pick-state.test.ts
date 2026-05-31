import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  clearCherryPickHead,
  conflictMergeMsg,
  readCherryPickHead,
  writeCherryPickHead,
} from '../../../../../src/application/commands/internal/cherry-pick-state.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const OID = 'a'.repeat(40) as ObjectId;
const headPath = (ctx: ReturnType<typeof createMemoryContext>): string =>
  `${ctx.layout.gitDir}/CHERRY_PICK_HEAD`;

describe('cherry-pick-state', () => {
  describe('Given writeCherryPickHead', () => {
    describe('When a picked commit id is written', () => {
      it('Then the file holds the oid plus a trailing LF', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeCherryPickHead(ctx, OID);

        // Assert
        expect(await ctx.fs.readUtf8(headPath(ctx))).toBe(`${OID}\n`);
      });
    });
  });

  describe('Given readCherryPickHead', () => {
    describe('When CHERRY_PICK_HEAD exists', () => {
      it('Then returns the recorded oid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeCherryPickHead(ctx, OID);

        // Act
        const sut = await readCherryPickHead(ctx);

        // Assert
        expect(sut).toBe(OID);
      });
    });

    describe('When CHERRY_PICK_HEAD is absent', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readCherryPickHead(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });

    describe('When CHERRY_PICK_HEAD is empty', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(headPath(ctx), '\n');

        // Act
        const sut = await readCherryPickHead(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });

    describe('When CHERRY_PICK_HEAD is corrupt', () => {
      it('Then throws INVALID_OBJECT_ID', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(headPath(ctx), 'not-a-valid-oid\n');

        // Act
        let caught: TsgitError | undefined;
        try {
          await readCherryPickHead(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_OBJECT_ID');
      });
    });
  });

  describe('Given clearCherryPickHead', () => {
    describe('When the file exists', () => {
      it('Then removes it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeCherryPickHead(ctx, OID);

        // Act
        await clearCherryPickHead(ctx);

        // Assert
        expect(await ctx.fs.exists(headPath(ctx))).toBe(false);
      });
    });

    describe('When the file is absent', () => {
      it('Then is a no-op (idempotent)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act + Assert (does not throw)
        await clearCherryPickHead(ctx);
        expect(await ctx.fs.exists(headPath(ctx))).toBe(false);
      });
    });
  });

  describe('Given conflictMergeMsg', () => {
    describe('When one path conflicts', () => {
      it('Then appends a tab-indented Conflicts block to the draft', () => {
        // Arrange + Act
        const sut = conflictMergeMsg('pick-A subject', ['f.txt' as FilePath]);

        // Assert
        expect(sut).toBe('pick-A subject\n\n# Conflicts:\n#\tf.txt\n');
      });
    });

    describe('When multiple paths conflict', () => {
      it('Then lists every path on its own tab-indented line', () => {
        // Arrange + Act
        const sut = conflictMergeMsg('msg', ['a.txt' as FilePath, 'b/c.txt' as FilePath]);

        // Assert
        expect(sut).toBe('msg\n\n# Conflicts:\n#\ta.txt\n#\tb/c.txt\n');
      });
    });

    describe('When the draft already ends with a trailing newline', () => {
      it('Then collapses to exactly one blank line before the block (git bytes)', () => {
        // Arrange + Act — a stripspace'd message ends in a single LF
        const sut = conflictMergeMsg('subject\n', ['f.txt' as FilePath]);

        // Assert
        expect(sut).toBe('subject\n\n# Conflicts:\n#\tf.txt\n');
      });
    });
  });
});

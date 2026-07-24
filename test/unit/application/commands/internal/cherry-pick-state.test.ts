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
    describe('When the message and conflicting paths are formatted', () => {
      it.each([
        {
          draft: 'pick-A subject',
          paths: ['f.txt' as FilePath],
          expected: 'pick-A subject\n\n# Conflicts:\n#\tf.txt\n',
          label: 'appends a tab-indented Conflicts block to the draft',
        },
        {
          draft: 'msg',
          paths: ['a.txt' as FilePath, 'b/c.txt' as FilePath],
          expected: 'msg\n\n# Conflicts:\n#\ta.txt\n#\tb/c.txt\n',
          label: 'lists every path on its own tab-indented line',
        },
        {
          draft: 'subject\n',
          paths: ['f.txt' as FilePath],
          expected: 'subject\n\n# Conflicts:\n#\tf.txt\n',
          label:
            'collapses to exactly one blank line before the block when the draft already ends with a trailing newline (git bytes)',
        },
        {
          draft: 'subject  \n\n',
          paths: ['f.txt' as FilePath],
          expected: 'subject\n\n# Conflicts:\n#\tf.txt\n',
          label:
            'strips the whole trailing whitespace run, not just one character (proves the strip is greedy — `\\s+$`, not `\\s$`)',
        },
      ])('Then $label', ({ draft, paths, expected }) => {
        // Arrange + Act
        const sut = conflictMergeMsg(draft, paths);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

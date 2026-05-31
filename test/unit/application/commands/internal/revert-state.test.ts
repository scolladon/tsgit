import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  clearRevertHead,
  quoteSubject,
  readRevertHead,
  revertMessage,
  writeRevertHead,
} from '../../../../../src/application/commands/internal/revert-state.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { CommitData } from '../../../../../src/domain/objects/commit.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';

const OID = 'a'.repeat(40) as ObjectId;
const headPath = (ctx: ReturnType<typeof createMemoryContext>): string =>
  `${ctx.layout.gitDir}/REVERT_HEAD`;

const IDENT: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};
const commitWith = (message: string): CommitData => ({
  tree: 'b'.repeat(40) as ObjectId,
  parents: [],
  author: IDENT,
  committer: IDENT,
  message,
  extraHeaders: [],
});

describe('revert-state', () => {
  describe('Given quoteSubject', () => {
    describe('When the subject has no special characters', () => {
      it('Then wraps it in double quotes', () => {
        // Arrange + Act + Assert
        expect(quoteSubject('add feature')).toBe('"add feature"');
      });
    });

    describe('When the subject contains a double quote', () => {
      it('Then backslash-escapes the quote', () => {
        // Arrange + Act + Assert
        expect(quoteSubject('a"b')).toBe('"a\\"b"');
      });
    });

    describe('When the subject contains a backslash', () => {
      it('Then backslash-escapes the backslash', () => {
        // Arrange + Act + Assert
        expect(quoteSubject('a\\b')).toBe('"a\\\\b"');
      });
    });

    describe('When the subject contains both a backslash and a quote', () => {
      it('Then escapes each independently', () => {
        // Arrange + Act + Assert
        expect(quoteSubject('a\\b"c')).toBe('"a\\\\b\\"c"');
      });
    });
  });

  describe('Given revertMessage', () => {
    describe('When the source has a single-line message', () => {
      it('Then builds the git-faithful Revert message', () => {
        // Arrange + Act
        const sut = revertMessage(commitWith('second commit'), OID);

        // Assert
        expect(sut).toBe(`Revert "second commit"\n\nThis reverts commit ${OID}.\n`);
      });
    });

    describe('When the source message has a body', () => {
      it('Then uses only the subject (first line)', () => {
        // Arrange + Act
        const sut = revertMessage(commitWith('subject line\n\nbody paragraph'), OID);

        // Assert
        expect(sut).toBe(`Revert "subject line"\n\nThis reverts commit ${OID}.\n`);
      });
    });

    describe('When the source is itself a revert', () => {
      it('Then nests the quoted subject', () => {
        // Arrange + Act
        const sut = revertMessage(commitWith('Revert "x"'), OID);

        // Assert
        expect(sut).toBe(`Revert "Revert \\"x\\""\n\nThis reverts commit ${OID}.\n`);
      });
    });
  });

  describe('Given writeRevertHead', () => {
    describe('When a reverted commit id is written', () => {
      it('Then the file holds the oid plus a trailing LF', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRevertHead(ctx, OID);

        // Assert
        expect(await ctx.fs.readUtf8(headPath(ctx))).toBe(`${OID}\n`);
      });
    });
  });

  describe('Given readRevertHead', () => {
    describe('When REVERT_HEAD exists', () => {
      it('Then returns the recorded oid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRevertHead(ctx, OID);

        // Act
        const sut = await readRevertHead(ctx);

        // Assert
        expect(sut).toBe(OID);
      });
    });

    describe('When REVERT_HEAD is absent', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readRevertHead(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });

    describe('When REVERT_HEAD is corrupt', () => {
      it('Then throws INVALID_OBJECT_ID', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(headPath(ctx), 'not-a-valid-oid\n');

        // Act
        let caught: TsgitError | undefined;
        try {
          await readRevertHead(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_OBJECT_ID');
      });
    });
  });

  describe('Given clearRevertHead', () => {
    describe('When the file exists', () => {
      it('Then removes it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRevertHead(ctx, OID);

        // Act
        await clearRevertHead(ctx);

        // Assert
        expect(await ctx.fs.exists(headPath(ctx))).toBe(false);
      });
    });

    describe('When the file is absent', () => {
      it('Then is a no-op (idempotent)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act + Assert (does not throw)
        await clearRevertHead(ctx);
        expect(await ctx.fs.exists(headPath(ctx))).toBe(false);
      });
    });
  });
});

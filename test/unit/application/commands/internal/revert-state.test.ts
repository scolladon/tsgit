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
    describe('When the subject is quoted', () => {
      it.each([
        {
          input: 'add feature',
          expected: '"add feature"',
          label: 'a subject with no special characters is wrapped in double quotes',
        },
        {
          input: 'a"b',
          expected: '"a\\"b"',
          label: 'a subject containing a double quote is backslash-escaped',
        },
        {
          input: 'a\\b',
          expected: '"a\\\\b"',
          label: 'a subject containing a backslash is backslash-escaped',
        },
        {
          input: 'a\\b"c',
          expected: '"a\\\\b\\"c"',
          label: 'a subject containing both a backslash and a quote has each escaped independently',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange + Act + Assert
        expect(quoteSubject(input)).toBe(expected);
      });
    });
  });

  describe('Given revertMessage', () => {
    describe('When the revert message is built', () => {
      it.each([
        {
          message: 'second commit',
          expected: `Revert "second commit"\n\nThis reverts commit ${OID}.\n`,
          label: 'a single-line source message builds the git-faithful Revert message',
        },
        {
          message: 'subject line\n\nbody paragraph',
          expected: `Revert "subject line"\n\nThis reverts commit ${OID}.\n`,
          label: 'a source message with a body uses only the subject (first line)',
        },
        {
          message: 'Revert "x"',
          expected: `Revert "Revert \\"x\\""\n\nThis reverts commit ${OID}.\n`,
          label: 'a source that is itself a revert nests the quoted subject',
        },
      ])('Then $label', ({ message, expected }) => {
        // Arrange + Act
        const sut = revertMessage(commitWith(message), OID);

        // Assert
        expect(sut).toBe(expected);
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

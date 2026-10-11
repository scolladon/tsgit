import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  deleteRootRef,
  readRootRef,
  rootRefExists,
  writeRootRef,
} from '../../../../../src/application/primitives/internal/root-ref.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { rejectionRecordingContext } from '../../../../fixtures/rejection-recording-context.js';
import { withReftableStorage } from '../reftable-fixtures.js';

type Logged = readonly [level: string, message: string];

const NAME = 'CHERRY_PICK_HEAD' as RefName;
const OID = '1234567890123456789012345678901234567890';

const loggingContext = (): { readonly ctx: Context; readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const logger = { error: (message: string) => logged.push(['error', message]) };
  return { ctx: { ...createMemoryContext(), logger }, logged };
};

const looseFile = (ctx: Context): string => `${ctx.layout.gitDir}/${NAME}`;

const plant = (ctx: Context, content: string): Promise<void> =>
  ctx.fs.writeUtf8(looseFile(ctx), content);

const blob = (ctx: Context) =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: new Uint8Array([0x78]) });

const failingReads = (ctx: Context, failure: Error): Context => ({
  ...ctx,
  fs: {
    ...ctx.fs,
    openWithNoFollow: async () => {
      throw failure;
    },
  },
});

describe('root-ref', () => {
  describe('Given a files repository', () => {
    describe('When writeRootRef records an object', () => {
      it('Then the loose file holds its id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await blob(ctx);
        const sut = writeRootRef;

        // Act
        await sut(ctx, NAME, id);

        // Assert
        const result = await ctx.fs.readUtf8(looseFile(ctx));
        expect(result).toBe(`${id}\n`);
      });
    });
  });

  describe('Given a root ref that is a symbolic ref to a branch', () => {
    describe('When writeRootRef records an object', () => {
      it('Then the root ref itself is overwritten and the branch is left alone', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await blob(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${OID}\n`);
        await plant(ctx, 'ref: refs/heads/main\n');
        const sut = writeRootRef;

        // Act
        await sut(ctx, NAME, id);

        // Assert
        expect(await ctx.fs.readUtf8(looseFile(ctx))).toBe(`${id}\n`);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(`${OID}\n`);
      });
    });
  });

  describe('Given a root ref that already has a reflog', () => {
    describe('When writeRootRef records an object', () => {
      it('Then the reflog entry carries no message, as git writes none', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await blob(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/${NAME}`, '');
        const sut = writeRootRef;

        // Act
        await sut(ctx, NAME, id);

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/logs/${NAME}`);
        expect(result).toMatch(new RegExp(`^${'0'.repeat(40)} ${id} [^\\t]+ \\d+ [+-]\\d{4}\\n$`));
      });
    });
  });

  describe('Given a reftable repository', () => {
    describe('When writeRootRef records an object', () => {
      it('Then the stack resolves it and no loose file exists', async () => {
        // Arrange
        const ctx = withReftableStorage(createMemoryContext());
        const id = await blob(ctx);
        const sut = writeRootRef;

        // Act
        await sut(ctx, NAME, id);

        // Assert
        expect(await readRootRef(ctx, NAME)).toBe(id);
        expect(await ctx.fs.exists(looseFile(ctx))).toBe(false);
      });
    });
  });

  describe('Given a root ref holding an id', () => {
    describe('When readRootRef and rootRefExists read it', () => {
      it('Then they report the id and its presence', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await plant(ctx, `${OID}\n`);
        const sut = readRootRef;

        // Act
        const result = await sut(ctx, NAME);

        // Assert
        expect(result).toBe(OID);
        expect(await rootRefExists(ctx, NAME)).toBe(true);
      });
    });
  });

  describe.each([
    { label: 'no root ref', content: undefined },
    { label: 'a root ref holding no object id', content: 'garbage\n' },
  ])('Given $label', ({ content }) => {
    describe('When readRootRef and rootRefExists read it', () => {
      it('Then it reads as absent, as git reads a broken ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        if (content !== undefined) await plant(ctx, content);
        const sut = readRootRef;

        // Act
        const result = await sut(ctx, NAME);

        // Assert
        expect(result).toBeUndefined();
        expect(await rootRefExists(ctx, NAME)).toBe(false);
      });
    });
  });

  describe('Given a root ref holding an id', () => {
    describe('When deleteRootRef removes it', () => {
      it('Then the ref is gone and nothing is reported', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        await plant(ctx, `${OID}\n`);
        const sut = deleteRootRef;

        // Act
        await sut(ctx, NAME);

        // Assert
        expect(await ctx.fs.exists(looseFile(ctx))).toBe(false);
        expect(logged).toEqual([]);
      });
    });
  });

  describe('Given a root ref holding no object id', () => {
    describe('When deleteRootRef removes it', () => {
      it('Then git reports the broken ref and leaves it in place', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        await plant(ctx, 'garbage\n');
        const sut = deleteRootRef;

        // Act
        await sut(ctx, NAME);

        // Assert
        expect(await ctx.fs.readUtf8(looseFile(ctx))).toBe('garbage\n');
        expect(logged).toEqual([
          [
            'error',
            "cannot lock ref 'CHERRY_PICK_HEAD': unable to resolve reference 'CHERRY_PICK_HEAD': reference broken",
          ],
        ]);
      });
    });
  });

  describe('Given a root ref that is a symbolic ref to a branch', () => {
    describe('When deleteRootRef removes it', () => {
      it('Then the root ref is deleted and the branch survives', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${OID}\n`);
        await plant(ctx, 'ref: refs/heads/main\n');
        const sut = deleteRootRef;

        // Act
        await sut(ctx, NAME);

        // Assert
        expect(await ctx.fs.exists(looseFile(ctx))).toBe(false);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(`${OID}\n`);
      });
    });
  });

  describe('Given a configured repository holding no AUTO_MERGE and no log of it', () => {
    describe('When deleteRootRef removes it', () => {
      it('Then no probe of the ref, its log or packed-refs is answered by a refusal', async () => {
        // Arrange
        const base = createMemoryContext();
        await base.fs.writeUtf8(`${base.layout.gitDir}/config`, '[core]\n');
        await base.fs.writeUtf8(`${base.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const { ctx, rejections } = rejectionRecordingContext(base);
        const sut = deleteRootRef;

        // Act
        await sut(ctx, 'AUTO_MERGE' as RefName);

        // Assert
        const result = rejections();
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a root ref whose delete fails for another reason', () => {
    describe('When deleteRootRef removes it', () => {
      it('Then the failure propagates', async () => {
        // Arrange
        const failure = new Error('disk failure');
        const planted = createMemoryContext();
        await plant(planted, `${OID}\n`);
        const ctx = failingReads(planted, failure);
        const sut = deleteRootRef;

        // Act
        const result = await sut(ctx, NAME).catch((error: unknown) => error);

        // Assert
        expect(result).toBe(failure);
      });
    });
  });
});

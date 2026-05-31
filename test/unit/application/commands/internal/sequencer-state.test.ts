import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  clearSequencer,
  readAbortSafety,
  readSequencerHead,
  readSequencerOpts,
  readSequencerTodo,
  writeAbortSafety,
  writeSequencerHead,
  writeSequencerOpts,
  writeSequencerTodo,
} from '../../../../../src/application/commands/internal/sequencer-state.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../../src/domain/objects/index.js';

type Ctx = ReturnType<typeof createMemoryContext>;
const seqPath = (ctx: Ctx, name: string): string => `${ctx.layout.gitDir}/sequencer/${name}`;
const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const blobOf = (n: number): Blob => ({
  type: 'blob',
  id: '' as ObjectId,
  content: new Uint8Array([n]),
});

describe('sequencer-state', () => {
  describe('Given head', () => {
    describe('When a head oid is written then read', () => {
      it('Then the file holds the oid + LF and reads back the oid', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeSequencerHead(ctx, OID_A);

        // Assert
        expect(await ctx.fs.readUtf8(seqPath(ctx, 'head'))).toBe(`${OID_A}\n`);
        expect(await readSequencerHead(ctx)).toBe(OID_A);
      });
    });

    describe('When head is absent', () => {
      it('Then read returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readSequencerHead(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });

    describe('When head is corrupt', () => {
      it('Then read throws INVALID_OBJECT_ID', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(seqPath(ctx, 'head'), 'garbage\n');

        // Act
        let caught: TsgitError | undefined;
        try {
          await readSequencerHead(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_OBJECT_ID');
      });
    });
  });

  describe('Given abort-safety', () => {
    describe('When an oid is written then read', () => {
      it('Then the file holds the oid + LF and reads back the oid', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeAbortSafety(ctx, OID_B);

        // Assert
        expect(await ctx.fs.readUtf8(seqPath(ctx, 'abort-safety'))).toBe(`${OID_B}\n`);
        expect(await readAbortSafety(ctx)).toBe(OID_B);
      });
    });

    describe('When abort-safety is absent', () => {
      it('Then read returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readAbortSafety(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given todo', () => {
    describe('When full-oid entries are written then read', () => {
      it('Then writes pick lines and reads them back resolved', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = [
          { command: 'pick' as const, oid: OID_A, subject: 'c1' },
          { command: 'pick' as const, oid: OID_B, subject: 'c2' },
        ];

        // Act
        await writeSequencerTodo(ctx, entries);

        // Assert
        expect(await ctx.fs.readUtf8(seqPath(ctx, 'todo'))).toBe(
          `pick ${OID_A} c1\npick ${OID_B} c2\n`,
        );
        expect(await readSequencerTodo(ctx)).toEqual([
          { command: 'pick', oid: OID_A, subject: 'c1' },
          { command: 'pick', oid: OID_B, subject: 'c2' },
        ]);
      });
    });

    describe('When revert-keyword entries are written then read', () => {
      it('Then writes revert lines and reads them back preserving the command', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = [
          { command: 'revert' as const, oid: OID_A, subject: 'Revert "c1"' },
          { command: 'revert' as const, oid: OID_B, subject: 'Revert "c2"' },
        ];

        // Act
        await writeSequencerTodo(ctx, entries);

        // Assert
        expect(await ctx.fs.readUtf8(seqPath(ctx, 'todo'))).toBe(
          `revert ${OID_A} Revert "c1"\nrevert ${OID_B} Revert "c2"\n`,
        );
        expect(await readSequencerTodo(ctx)).toEqual([
          { command: 'revert', oid: OID_A, subject: 'Revert "c1"' },
          { command: 'revert', oid: OID_B, subject: 'Revert "c2"' },
        ]);
      });
    });

    describe("When the todo holds git's abbreviated oids", () => {
      it('Then read resolves them against the object store', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await writeObject(ctx, blobOf(0x42));
        await ctx.fs.writeUtf8(seqPath(ctx, 'todo'), `pick ${id.slice(0, 7)} subj\n`);

        // Act
        const sut = await readSequencerTodo(ctx);

        // Assert
        expect(sut).toEqual([{ command: 'pick', oid: id, subject: 'subj' }]);
      });
    });

    describe('When the todo is absent', () => {
      it('Then read returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readSequencerTodo(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });

    describe('When the todo references an unknown oid', () => {
      it('Then read throws INVALID_SEQUENCER_TODO', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(seqPath(ctx, 'todo'), 'pick deadbeef gone\n');

        // Act
        let caught: TsgitError | undefined;
        try {
          await readSequencerTodo(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_SEQUENCER_TODO');
      });
    });
  });

  describe('Given opts', () => {
    describe('When non-default options are written then read', () => {
      it('Then only the set keys are written in git-config format', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeSequencerOpts(ctx, { noCommit: true, recordOrigin: true, allowEmpty: false });

        // Assert
        expect(await ctx.fs.readUtf8(seqPath(ctx, 'opts'))).toBe(
          '[options]\n\tno-commit = true\n\trecord-origin = true\n',
        );
        expect(await readSequencerOpts(ctx)).toEqual({
          noCommit: true,
          recordOrigin: true,
          allowEmpty: false,
        });
      });
    });

    describe('When all options are default', () => {
      it('Then no opts file is written and read returns all-false', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeSequencerOpts(ctx, { noCommit: false, recordOrigin: false, allowEmpty: false });

        // Assert
        expect(await ctx.fs.exists(seqPath(ctx, 'opts'))).toBe(false);
        expect(await readSequencerOpts(ctx)).toEqual({
          noCommit: false,
          recordOrigin: false,
          allowEmpty: false,
        });
      });
    });

    describe('When git wrote an allow-empty opts file', () => {
      it('Then read parses allow-empty true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          seqPath(ctx, 'opts'),
          '[options]\n\tno-commit = true\n\tallow-empty = true\n',
        );

        // Act
        const sut = await readSequencerOpts(ctx);

        // Assert
        expect(sut).toEqual({ noCommit: true, recordOrigin: false, allowEmpty: true });
      });
    });
  });

  describe('Given clearSequencer', () => {
    describe('When the sequencer directory exists', () => {
      it('Then it is removed entirely', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSequencerHead(ctx, OID_A);
        await writeSequencerTodo(ctx, [{ command: 'pick', oid: OID_A, subject: 'c1' }]);

        // Act
        await clearSequencer(ctx);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });

    describe('When the sequencer directory is absent', () => {
      it('Then clear is a no-op', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await clearSequencer(ctx);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given opts written one flag at a time', () => {
    describe.each([
      ['no-commit', { noCommit: true, recordOrigin: false, allowEmpty: false }],
      ['record-origin', { noCommit: false, recordOrigin: true, allowEmpty: false }],
      ['allow-empty', { noCommit: false, recordOrigin: false, allowEmpty: true }],
    ])('When only %s is set', (key, opts) => {
      it(`Then the file holds exactly that one key and round-trips`, async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeSequencerOpts(ctx, opts);

        // Assert — exactly one option line is serialised (kills per-flag guards).
        expect(await ctx.fs.readUtf8(seqPath(ctx, 'opts'))).toBe(`[options]\n\t${key} = true\n`);
        expect(await readSequencerOpts(ctx)).toEqual(opts);
      });
    });
  });

  describe('Given an opts file with a non-options section carrying the key', () => {
    describe('When read', () => {
      it('Then the key is ignored unless it lives under [options]', async () => {
        // Arrange — `allow-empty` sits under [core], never under [options].
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          seqPath(ctx, 'opts'),
          '[core]\n\tallow-empty = true\n[options]\n\tno-commit = true\n',
        );

        // Act
        const sut = await readSequencerOpts(ctx);

        // Assert
        expect(sut).toEqual({ noCommit: true, recordOrigin: false, allowEmpty: false });
      });
    });
  });

  describe('Given a todo referencing an unresolvable oid', () => {
    describe('When read', () => {
      it('Then the INVALID_SEQUENCER_TODO reason echoes the unresolved oid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(seqPath(ctx, 'todo'), 'pick c0ffee00 ghost\n');

        // Act
        let caught: TsgitError | undefined;
        try {
          await readSequencerTodo(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_SEQUENCER_TODO');
        expect((caught?.data as { reason: string }).reason).toContain('c0ffee00');
      });
    });
  });
});

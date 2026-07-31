import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { isWhitespaceOnlyModify } from '../../../../../src/application/primitives/internal/whitespace-drop-predicate.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import type { ModifyChange } from '../../../../../src/domain/diff/diff-change.js';
import { type LineKey, NONE_KEY } from '../../../../../src/domain/diff/whitespace.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { Blob, FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import type { Compressor } from '../../../../../src/ports/compressor.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const enc = new TextEncoder();
const ALL_KEY: LineKey = { mode: 'all', ignoreCrAtEol: false };
const MANY_SHORT_LINES = 'x'.repeat(99).concat('\n').repeat(700);

function changeFor(oldId: ObjectId, newId: ObjectId): ModifyChange {
  return {
    type: 'modify',
    path: 'f.txt' as FilePath,
    oldId,
    newId,
    oldMode: FILE_MODE.REGULAR,
    newMode: FILE_MODE.REGULAR,
  };
}

async function writeBlob(ctx: Context, content: Uint8Array): Promise<ObjectId> {
  const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
  return writeObject(ctx, blob);
}

/** Deterministic, deflate-resistant bytes — big enough on disk to land the
 *  loose arm over the buffered gate regardless of compression. */
function incompressibleBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const QUOTA = 65_536; // Web Crypto's per-call getRandomValues ceiling.
  for (let start = 0; start < size; start += QUOTA) {
    crypto.getRandomValues(out.subarray(start, Math.min(start + QUOTA, size)));
  }
  return out;
}

/** Wraps a real Compressor, counting `createInflateStream` calls — the
 *  observable, timing-free signal of "this side streamed". */
function countingCompressor(base: Compressor): {
  readonly compressor: Compressor;
  readonly streamCount: () => number;
} {
  let count = 0;
  const compressor: Compressor = {
    ...base,
    createInflateStream: () => {
      count += 1;
      return base.createInflateStream();
    },
  };
  return { compressor, streamCount: () => count };
}

async function countingContext(): Promise<{
  readonly ctx: Context;
  readonly streamCount: () => number;
}> {
  const base = await buildSeededContext();
  const { compressor, streamCount } = countingCompressor(base.compressor);
  return { ctx: { ...base, compressor }, streamCount };
}

interface VerdictRow {
  readonly label: string;
  readonly oldText: string;
  readonly newText: string;
  readonly lineKey: LineKey;
  readonly expected: boolean;
}

const VERDICT_TABLE: readonly VerdictRow[] = [
  {
    label: 'a whitespace-run-only change under ignoreWhitespace:all is dropped',
    oldText: 'hello world\n',
    newText: 'hello  world\n',
    lineKey: ALL_KEY,
    expected: true,
  },
  {
    label: 'a real content change under ignoreWhitespace:all is kept',
    oldText: 'hello\n',
    newText: 'world\n',
    lineKey: ALL_KEY,
    expected: false,
  },
  {
    label: 'two empty blobs are dropped',
    oldText: '',
    newText: '',
    lineKey: ALL_KEY,
    expected: true,
  },
  {
    label: 'an empty blob against a non-empty one is kept',
    oldText: '',
    newText: 'x\n',
    lineKey: ALL_KEY,
    expected: false,
  },
  {
    label: 'two single-LF (blank-line) blobs are dropped',
    oldText: '\n',
    newText: '\n',
    lineKey: ALL_KEY,
    expected: true,
  },
  {
    label: 'a single-LF blob against an empty one is kept',
    oldText: '\n',
    newText: '',
    lineKey: ALL_KEY,
    expected: false,
  },
  {
    label: 'an unterminated final line with a whitespace-only change is dropped',
    oldText: 'abc',
    newText: 'a  bc',
    lineKey: ALL_KEY,
    expected: true,
  },
  {
    label: 'a real content change confined to the final unterminated line is kept',
    oldText: 'same\nold-tail',
    newText: 'same\nnew-tail',
    lineKey: NONE_KEY,
    expected: false,
  },
  {
    label:
      'many short terminated lines summing past MAX_LINE_BYTES with identical content are dropped',
    oldText: MANY_SHORT_LINES,
    newText: MANY_SHORT_LINES,
    lineKey: NONE_KEY,
    expected: true,
  },
];

describe('isWhitespaceOnlyModify', () => {
  describe('Given both blobs resolve under the buffered gate', () => {
    describe('When isWhitespaceOnlyModify runs at the default gate', () => {
      it('Then no createInflateStream call is made (both sides buffer)', async () => {
        // Arrange
        const { ctx, streamCount } = await countingContext();
        const oldId = await writeBlob(ctx, enc.encode('hello world\n'));
        const newId = await writeBlob(ctx, enc.encode('hello  world\n'));

        // Act
        await isWhitespaceOnlyModify(ctx, changeFor(oldId, newId), ALL_KEY, false);

        // Assert
        expect(streamCount()).toBe(0);
      });
    });
  });

  describe('Given both blobs resolve over the buffered gate', () => {
    describe('When isWhitespaceOnlyModify runs at the default gate', () => {
      it('Then createInflateStream is called once per side (both sides stream)', async () => {
        // Arrange
        const { ctx, streamCount } = await countingContext();
        const oldId = await writeBlob(ctx, incompressibleBytes(70_000));
        const newId = await writeBlob(ctx, incompressibleBytes(70_000));

        // Act
        await isWhitespaceOnlyModify(ctx, changeFor(oldId, newId), ALL_KEY, false);

        // Assert
        expect(streamCount()).toBe(2);
      });
    });
  });

  describe('Given one blob resolves under and the other over the buffered gate', () => {
    describe('When isWhitespaceOnlyModify runs at the default gate', () => {
      it('Then createInflateStream is called once, for the streamed side only', async () => {
        // Arrange
        const { ctx, streamCount } = await countingContext();
        const oldId = await writeBlob(ctx, enc.encode('hello world\n'));
        const newId = await writeBlob(ctx, incompressibleBytes(70_000));

        // Act
        await isWhitespaceOnlyModify(ctx, changeFor(oldId, newId), ALL_KEY, false);

        // Assert
        expect(streamCount()).toBe(1);
      });
    });
  });

  describe('Given a table of whitespace-only and real-content modify pairs', () => {
    describe('When isWhitespaceOnlyModify runs at the default gate and forced onto the streaming arm (gate 0)', () => {
      it.each(VERDICT_TABLE)(
        'Then $label, identically on both arms',
        async ({ oldText, newText, lineKey, expected }) => {
          // Arrange
          const ctx = await buildSeededContext();
          const oldId = await writeBlob(ctx, enc.encode(oldText));
          const newId = await writeBlob(ctx, enc.encode(newText));
          const change = changeFor(oldId, newId);

          // Act
          const buffered = await isWhitespaceOnlyModify(ctx, change, lineKey, false);
          const streamed = await isWhitespaceOnlyModify(ctx, change, lineKey, false, 0);

          // Assert
          expect(buffered).toBe(expected);
          expect(streamed).toBe(expected);
        },
      );
    });
  });

  describe('Given a NUL byte inside the binary-detection window on one side only', () => {
    describe('When isWhitespaceOnlyModify runs, at the default gate and forced onto the streaming arm', () => {
      it('Then the modify is kept — a binary side is never dropped', async () => {
        // Arrange
        const clean = enc.encode('same content\n');
        const withNul = new Uint8Array(clean.length + 1);
        withNul[0] = 0x00;
        withNul.set(clean, 1);
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, withNul);
        const newId = await writeBlob(ctx, clean);
        const change = changeFor(oldId, newId);

        // Act
        const buffered = await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false);
        const streamed = await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false, 0);

        // Assert
        expect(buffered).toBe(false);
        expect(streamed).toBe(false);
      });
    });
  });

  describe('Given a missing object id', () => {
    describe('When isWhitespaceOnlyModify is called', () => {
      it('Then throws objectNotFound with the missing id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const missing = 'f'.repeat(40) as ObjectId;
        const change = changeFor(missing, missing);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(missing);
          }
        }
      });
    });
  });

  describe('Given a change pointing at a tree oid, small enough to resolve buffered', () => {
    describe('When isWhitespaceOnlyModify is called at the default gate', () => {
      it('Then throws unexpectedObjectType, refused on the buffered arm (zero stream calls)', async () => {
        // Arrange
        const { ctx, streamCount } = await countingContext();
        const leafId = await writeBlob(ctx, enc.encode('leaf\n'));
        const treeId = await writeTree(ctx, [
          { name: 'leaf.txt', mode: FILE_MODE.REGULAR, id: leafId },
        ]);
        const change = changeFor(treeId, treeId);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
          if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
            expect(data.expected).toBe('blob');
            expect(data.actual).toBe('tree');
            expect(data.id).toBe(treeId);
          }
        }
        expect(streamCount()).toBe(0);
      });
    });
  });

  describe('Given a corrupted loose blob resolved buffered', () => {
    describe('When isWhitespaceOnlyModify is called at the default gate', () => {
      it('Then throws objectHashMismatch', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc.encode('original\n'));
        const corruptContent = enc.encode('CORRUPTED\n');
        const corruptBytes = enc.encode(`blob ${corruptContent.length}\0`);
        const fullCorrupt = new Uint8Array(corruptBytes.length + corruptContent.length);
        fullCorrupt.set(corruptBytes, 0);
        fullCorrupt.set(corruptContent, corruptBytes.length);
        const compressed = await ctx.compressor.deflate(fullCorrupt);
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.write(loosePath, compressed);
        const change = changeFor(id, id);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(id);
            expect(data.actual).not.toBe(id);
          }
        }
      });
    });
  });

  describe('Given a ctx.signal aborted before the call', () => {
    describe('When isWhitespaceOnlyModify is called', () => {
      it('Then throws operationAborted', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        controller.abort();
        const someId = 'a'.repeat(40) as ObjectId;
        const change = changeFor(someId, someId);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });
});

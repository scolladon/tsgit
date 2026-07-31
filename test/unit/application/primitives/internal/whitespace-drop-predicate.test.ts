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
import {
  DIGEST_COLLISION_LINE_A,
  DIGEST_COLLISION_LINE_B,
} from '../../../../fixtures/digest-collision-pair.js';
import { pseudoRandomBytes } from '../../../../fixtures/pseudo-random-bytes.js';
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

/** Deflate-resistant even at this size, so the blob lands on disk over the
 *  buffered gate and its side really streams. `pseudoRandomBytes` excludes
 *  NUL/LF/CR, so a streamed side folds every chunk into one line's digest
 *  instead of bailing binary before the first comparison. */
const STREAMED_BLOB_BYTES = 70_000;

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

/** Re-exposes a readable through an underlying source whose `cancel` hook is
 *  observable — the release signal a leaked reader would never produce. */
function trackedReadable(
  source: ReadableStream<Uint8Array>,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel: async (reason) => {
      onCancel();
      await reader.cancel(reason);
    },
  });
}

/** A context whose inflate streams report how many were cancelled — an
 *  un-cancelled stream is exactly the leaked reader/inflate instance. */
async function cancelTrackingContext(): Promise<{
  readonly ctx: Context;
  readonly cancelCount: () => number;
}> {
  const base = await buildSeededContext();
  let cancels = 0;
  const compressor: Compressor = {
    ...base.compressor,
    createInflateStream: () => {
      const inner = base.compressor.createInflateStream();
      return {
        readable: trackedReadable(inner.readable, () => {
          cancels += 1;
        }),
        writable: inner.writable,
      };
    },
  };
  return { ctx: { ...base, compressor }, cancelCount: () => cancels };
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
  {
    label: "a digest-colliding pair of distinct lines is kept under ignoreWhitespace:'all'",
    oldText: DIGEST_COLLISION_LINE_A,
    newText: DIGEST_COLLISION_LINE_B,
    lineKey: ALL_KEY,
    expected: false,
  },
  {
    label: "a digest-colliding pair of distinct lines is kept under ignoreWhitespace:'change'",
    oldText: DIGEST_COLLISION_LINE_A,
    newText: DIGEST_COLLISION_LINE_B,
    lineKey: { mode: 'change', ignoreCrAtEol: false },
    expected: false,
  },
  {
    label: "a digest-colliding pair of distinct lines is kept under ignoreWhitespace:'at-eol'",
    oldText: DIGEST_COLLISION_LINE_A,
    newText: DIGEST_COLLISION_LINE_B,
    lineKey: { mode: 'at-eol', ignoreCrAtEol: false },
    expected: false,
  },
  {
    label: 'a digest-colliding line surrounded by identical lines is kept',
    oldText: `head\n${DIGEST_COLLISION_LINE_A}\ntail\n`,
    newText: `head\n${DIGEST_COLLISION_LINE_B}\ntail\n`,
    lineKey: ALL_KEY,
    expected: false,
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
        const oldId = await writeBlob(ctx, pseudoRandomBytes(STREAMED_BLOB_BYTES, 1));
        const newId = await writeBlob(ctx, pseudoRandomBytes(STREAMED_BLOB_BYTES, 2));

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
        const newId = await writeBlob(ctx, pseudoRandomBytes(STREAMED_BLOB_BYTES, 3));

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

  describe('Given two streamed blobs whose digests differ', () => {
    describe('When isWhitespaceOnlyModify is forced onto the streaming arm (gate 0)', () => {
      it('Then each blob is inflated once — a "differs" verdict never re-reads', async () => {
        // Arrange
        const { ctx, streamCount } = await countingContext();
        const oldId = await writeBlob(ctx, enc.encode('hello\n'));
        const newId = await writeBlob(ctx, enc.encode('world\n'));

        // Act
        const result = await isWhitespaceOnlyModify(
          ctx,
          changeFor(oldId, newId),
          ALL_KEY,
          false,
          0,
        );

        // Assert
        expect(result).toBe(false);
        expect(streamCount()).toBe(2);
      });
    });
  });

  describe('Given streamed blobs whose digests agree but whose bytes do not', () => {
    describe('When the confirmation re-read abandons them at the first differing line (gate 0)', () => {
      it('Then both re-opened streams are cancelled, not left to GC', async () => {
        // Arrange — the colliding pair drives the ladder to a would-be-drop, so
        // the confirmation runs and then bails on the second line, leaving both
        // of its streams part-read.
        const { ctx, cancelCount } = await cancelTrackingContext();
        const oldId = await writeBlob(ctx, enc.encode(`head\n${DIGEST_COLLISION_LINE_A}\ntail\n`));
        const newId = await writeBlob(ctx, enc.encode(`head\n${DIGEST_COLLISION_LINE_B}\ntail\n`));

        // Act
        const result = await isWhitespaceOnlyModify(
          ctx,
          changeFor(oldId, newId),
          ALL_KEY,
          false,
          0,
        );

        // Assert — both cancels come from the confirmation: the digest pass ran
        // each side to EOF, and a stream already closed by its last read has
        // nothing left to cancel.
        expect(result).toBe(false);
        expect(cancelCount()).toBe(2);
      });
    });
  });

  describe('Given two streamed blobs whose digests agree', () => {
    describe('When isWhitespaceOnlyModify is forced onto the streaming arm (gate 0)', () => {
      it('Then each blob is inflated twice — the drop verdict is confirmed by a re-read', async () => {
        // Arrange
        const { ctx, streamCount } = await countingContext();
        const oldId = await writeBlob(ctx, enc.encode('hello world\n'));
        const newId = await writeBlob(ctx, enc.encode('hello  world\n'));

        // Act
        const result = await isWhitespaceOnlyModify(
          ctx,
          changeFor(oldId, newId),
          ALL_KEY,
          false,
          0,
        );

        // Assert
        expect(result).toBe(true);
        expect(streamCount()).toBe(4);
      });
    });
  });

  describe('Given streamed blobs equal only once blank lines are skipped', () => {
    describe('When isWhitespaceOnlyModify runs with ignoreBlankLines on the streaming arm (gate 0)', () => {
      it('Then the confirmation skips the blank lines too and the change is dropped', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc.encode('a\n\n\nb\n'));
        const newId = await writeBlob(ctx, enc.encode('\na\nb\n\n'));

        // Act
        const result = await isWhitespaceOnlyModify(
          ctx,
          changeFor(oldId, newId),
          NONE_KEY,
          true,
          0,
        );

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a streamed blob whose final line is unterminated and differs', () => {
    describe('When isWhitespaceOnlyModify is forced onto the streaming arm (gate 0)', () => {
      it('Then the change is kept — the confirmation sees the unterminated tail', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc.encode(`same\n${DIGEST_COLLISION_LINE_A}`));
        const newId = await writeBlob(ctx, enc.encode(`same\n${DIGEST_COLLISION_LINE_B}`));

        // Act
        const result = await isWhitespaceOnlyModify(
          ctx,
          changeFor(oldId, newId),
          ALL_KEY,
          false,
          0,
        );

        // Assert
        expect(result).toBe(false);
      });
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

  describe('Given one side refuses mid-stream while the other side streams', () => {
    describe('When isWhitespaceOnlyModify is forced onto the streaming arm (gate 0)', () => {
      it('Then both sides are cancelled instead of leaking their readers', async () => {
        // Arrange
        const { ctx, cancelCount } = await cancelTrackingContext();
        const leafId = await writeBlob(ctx, enc.encode('leaf\n'));
        const treeId = await writeTree(ctx, [
          { name: 'leaf.txt', mode: FILE_MODE.REGULAR, id: leafId },
        ]);
        const blobId = await writeBlob(ctx, enc.encode('content\n'));
        const change = changeFor(treeId, blobId);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false, 0);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        }
        expect(cancelCount()).toBe(2);
      });
    });
  });

  describe('Given one side fails to open while the other opens a stream', () => {
    describe('When isWhitespaceOnlyModify is forced onto the streaming arm (gate 0)', () => {
      it('Then the side that opened is cancelled instead of leaking its reader', async () => {
        // Arrange
        const { ctx, cancelCount } = await cancelTrackingContext();
        const missing = 'f'.repeat(40) as ObjectId;
        const blobId = await writeBlob(ctx, enc.encode('content\n'));
        const change = changeFor(missing, blobId);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false, 0);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
        }
        expect(cancelCount()).toBe(1);
      });
    });
  });

  describe('Given one side fails to open while the other opened a stream that has errored', () => {
    describe('When isWhitespaceOnlyModify is forced onto the streaming arm (gate 0)', () => {
      it('Then the open failure is reported, not the survivor’s release rejection', async () => {
        // Arrange — releasing the survivor cancels an already-errored readable,
        // which rejects with the stored error; that must not displace the real
        // one the caller is being told about.
        const base = await buildSeededContext();
        const inflateFailure = new Error('inflate blew up');
        const ctx: Context = {
          ...base,
          compressor: {
            ...base.compressor,
            createInflateStream: () => ({
              readable: new ReadableStream<Uint8Array>({
                start: (controller) => {
                  controller.error(inflateFailure);
                },
              }),
              writable: new WritableStream<Uint8Array>(),
            }),
          },
        };
        const missing = 'f'.repeat(40) as ObjectId;
        const blobId = await writeBlob(base, enc.encode('content\n'));
        const change = changeFor(missing, blobId);

        // Act + Assert
        try {
          await isWhitespaceOnlyModify(ctx, change, ALL_KEY, false, 0);
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { isWhitespaceOnlyModify } from '../../../../../src/application/primitives/internal/whitespace-drop-predicate.js';
import type { BlobStream } from '../../../../../src/application/primitives/stream-blob.js';
import * as streamBlobMod from '../../../../../src/application/primitives/stream-blob.js';
import type { ModifyChange } from '../../../../../src/domain/diff/diff-change.js';
import {
  BINARY_DETECTION_BYTES,
  MAX_LINE_BYTES,
  MAX_LINES,
} from '../../../../../src/domain/diff/line-diff.js';
import { NONE_KEY } from '../../../../../src/domain/diff/whitespace.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const enc = new TextEncoder();
const OLD_ID = 'a'.repeat(40) as ObjectId;
const NEW_ID = 'b'.repeat(40) as ObjectId;
const ctx = createMemoryContext();

const change: ModifyChange = {
  type: 'modify',
  path: 'f.txt' as FilePath,
  oldId: OLD_ID,
  newId: NEW_ID,
  oldMode: FILE_MODE.REGULAR,
  newMode: FILE_MODE.REGULAR,
};

// Yields exactly the given chunks, in order — gives each test precise control
// over chunk boundaries, which real (compressed/decompressed) blob storage
// cannot guarantee.
function chunkedStream(chunks: readonly Uint8Array[]): BlobStream {
  return {
    materialised: false,
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<Uint8Array>> => {
          if (index < chunks.length) {
            const value = chunks[index] as Uint8Array;
            index += 1;
            return Promise.resolve({ done: false, value });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

function stubStreams(oldChunks: readonly Uint8Array[], newChunks: readonly Uint8Array[]): void {
  vi.spyOn(streamBlobMod, 'streamBlob').mockImplementation(async (_ctx, id) => {
    if (id === OLD_ID) return chunkedStream(oldChunks);
    if (id === NEW_ID) return chunkedStream(newChunks);
    throw new Error(`unexpected blob id in test: ${id}`);
  });
}

describe('isWhitespaceOnlyModify', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a NUL byte in the chunk immediately after the NUL-detection window closes', () => {
    describe('When isWhitespaceOnlyModify runs on byte-identical streams', () => {
      it('Then the trailing NUL is ignored and the modify is dropped (nulScanOffset only ever grows)', async () => {
        // Arrange — the first chunk exactly exhausts the BINARY_DETECTION_BYTES
        // window; a NUL leading the second chunk must be ignored, not detected.
        const firstChunk = new Uint8Array(BINARY_DETECTION_BYTES).fill(0x78); // 'x' * 8000
        const secondChunk = new Uint8Array([0x00, 0x0a]); // NUL then LF, completes the line
        const chunks = [firstChunk, secondChunk];
        stubStreams(chunks, chunks);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a NUL byte exactly one position past the NUL-detection window on a partially-consumed budget', () => {
    describe('When isWhitespaceOnlyModify runs on byte-identical streams', () => {
      it('Then the out-of-window NUL is ignored and the modify is dropped', async () => {
        // Arrange — 7,995 bytes pre-consume the window (5 remain); the NUL sits
        // at chunk2[5], the first position the shrunk window must NOT scan.
        const firstChunk = new Uint8Array(BINARY_DETECTION_BYTES - 5).fill(0x78);
        const secondChunk = new Uint8Array(10).fill(0x79); // 'y'
        secondChunk[5] = 0x00;
        const chunks = [firstChunk, secondChunk];
        stubStreams(chunks, chunks);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a single LF-terminated line whose length lands exactly on the MAX_LINE_BYTES cap', () => {
    describe('When isWhitespaceOnlyModify runs on byte-identical streams', () => {
      it('Then the line trips the per-line cap and the modify is kept, not dropped', async () => {
        // Arrange — delivered as ONE chunk so the LF is found immediately and
        // the line completes through trackLineCaps, not the pending-bytes guard.
        const line = new Uint8Array(MAX_LINE_BYTES).fill(0x78);
        line[MAX_LINE_BYTES - 1] = 0x0a;
        const chunks = [line];
        stubStreams(chunks, chunks);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given exactly MAX_LINES worth of blank lines on byte-identical streams', () => {
    describe('When isWhitespaceOnlyModify runs', () => {
      it('Then the line-count cap trips at the boundary and the modify is kept, not dropped', async () => {
        // Arrange — MAX_LINES single-byte blank lines in one chunk; the
        // MAX_LINES-th completed line must trip the cap, not a later one.
        const chunks = [new Uint8Array(MAX_LINES).fill(0x0a)];
        stubStreams(chunks, chunks);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given many short terminated lines whose cumulative length exceeds MAX_LINE_BYTES but no single line does', () => {
    describe('When isWhitespaceOnlyModify runs on byte-identical streams', () => {
      it('Then the per-line cap never trips and the modify is dropped (currentLineBytes resets each line)', async () => {
        // Arrange — 700 lines x 100 bytes = 70,000 bytes cumulative (over
        // MAX_LINE_BYTES), but every individual line is far under the cap.
        const oneLine = new Uint8Array(100).fill(0x78);
        oneLine[99] = 0x0a;
        const bytes = new Uint8Array(700 * 100);
        for (let i = 0; i < 700; i++) bytes.set(oneLine, i * 100);
        const chunks = [bytes];
        stubStreams(chunks, chunks);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a real content difference confined to the final unterminated line', () => {
    describe('When isWhitespaceOnlyModify runs', () => {
      it('Then the differing final line is kept, not silently dropped at EOF', async () => {
        // Arrange — both sides share a terminated first line; their final,
        // unterminated lines differ in real (non-whitespace) content.
        stubStreams([enc.encode('same\nold-tail')], [enc.encode('same\nnew-tail')]);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the old side becomes binary exactly when the new side reaches a clean EOF', () => {
    describe('When isWhitespaceOnlyModify runs', () => {
      it('Then the modify is kept — a binary side alone must never be dropped', async () => {
        // Arrange — NEW ends cleanly after "same\n"; OLD continues into a
        // separate chunk carrying a NUL byte, delivered after "same\n" is
        // taken so the binary flag flips on OLD's second read, not NEW's.
        const oldChunks = [enc.encode('same\n'), new Uint8Array([0x00])];
        const newChunks = [enc.encode('same\n')];
        stubStreams(oldChunks, newChunks);

        // Act
        const result = await isWhitespaceOnlyModify(ctx, change, NONE_KEY, false);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

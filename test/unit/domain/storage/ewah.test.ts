import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import type { BitmapCheck } from '../../../../src/domain/storage/error.js';
import {
  type EwahStream,
  foldEwahStream,
  maxSetBitPosition,
  readEwahStream,
} from '../../../../src/domain/storage/ewah.js';
import { encodeEwah } from './arbitraries.js';

// --- Fixture helpers -------------------------------------------------------

/** A hand-crafted stream: `words` are `[high, low]` 32-bit halves of each
 *  big-endian 64-bit word — bypasses `encodeEwah` so Pin C's measured bytes
 *  are the oracle, not our own writer. */
function buildEwahStream(
  bitSize: number,
  words: ReadonlyArray<readonly [number, number]>,
  rlwPosition = 0,
): Uint8Array {
  const bytes = new Uint8Array(8 + words.length * 8 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bitSize);
  view.setUint32(4, words.length);
  words.forEach(([high, low], i) => {
    view.setUint32(8 + i * 8, high);
    view.setUint32(8 + i * 8 + 4, low);
  });
  view.setUint32(8 + words.length * 8, rlwPosition);
  return bytes;
}

function pokeWordCount(bytes: Uint8Array, wordCount: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(4, wordCount);
  return copy;
}

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Set bit positions of a folded destination, LSB-first within each lane. */
function bitsOf(into: Uint32Array): number[] {
  const bits: number[] = [];
  into.forEach((lane, laneIndex) => {
    for (let b = 0; b < 32; b += 1) {
      if ((lane & (1 << b)) !== 0) bits.push(laneIndex * 32 + b);
    }
  });
  return bits;
}

/** Re-derives each run-length word's clean-word count directly from
 *  `encodeEwah`'s own byte output — an oracle over the writer, independent
 *  of the production decoder. */
function runLengthWordCleanCounts(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer);
  const wordCount = view.getUint32(4);
  const cleanCounts: number[] = [];
  let wordIndex = 0;
  while (wordIndex < wordCount) {
    const offset = 8 + wordIndex * 8;
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    wordIndex += 1;
    cleanCounts.push(((low >>> 1) | ((high & 1) << 31)) >>> 0);
    wordIndex += high >>> 1;
  }
  return cleanCounts;
}

function expectRefusal(act: () => void, check: BitmapCheck, reasonContains: string): void {
  // Captured OUTSIDE the try: an expect.fail thrown inside it would be
  // swallowed by this function's own catch and resurface as a confusing
  // downstream TypeError instead of the intended message.
  let caught: unknown;
  try {
    act();
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) {
    expect.fail('Should have thrown');
  }
  const data = (caught as TsgitError).data;
  if (data.code !== 'INVALID_PACK_BITMAP') {
    expect.fail(`expected INVALID_PACK_BITMAP, got ${data.code}`);
  }
  expect(data.check).toBe(check);
  expect(data.reason).toContain(reasonContains);
}

function assertExhaustiveBitmapCheck(check: BitmapCheck): void {
  switch (check) {
    case 'size':
    case 'signature':
    case 'version':
    case 'options':
    case 'stream':
    case 'entry':
      return;
    default: {
      const _exhaustive: never = check;
      throw new Error(`Unhandled BitmapCheck: ${String(_exhaustive)}`);
    }
  }
}

// --- Tests -------------------------------------------------------------

describe('ewah', () => {
  describe('readEwahStream', () => {
    describe("Given Pin C's commits stream (bitSize=2, one literal word 0x3)", () => {
      describe('When reading the descriptor', () => {
        it('Then bitSize, wordCount, wordsOffset and endOffset are recovered', () => {
          // Arrange
          const bytes = buildEwahStream(2, [
            [0x2, 0x0],
            [0x0, 0x3],
          ]);
          const view = new DataView(bytes.buffer);

          // Act
          const result = readEwahStream(bytes, view, 0);

          // Assert
          expect(result).toEqual({ bitSize: 2, wordCount: 2, wordsOffset: 8, endOffset: 28 });
        });
      });
    });

    describe('Given the empty stream (bitSize=0, wordCount=1, word=0)', () => {
      describe('When reading the descriptor', () => {
        it('Then the stream is 20 bytes, not 12, and wordCount is 1', () => {
          // Arrange
          const bytes = buildEwahStream(0, [[0x0, 0x0]]);
          const view = new DataView(bytes.buffer);

          // Act
          const result = readEwahStream(bytes, view, 0);

          // Assert
          expect(bytes.length).toBe(20);
          expect(result).toEqual({ bitSize: 0, wordCount: 1, wordsOffset: 8, endOffset: 20 });
        });
      });
    });

    describe('Given a stream embedded at a non-zero offset', () => {
      describe('When reading the descriptor', () => {
        it('Then every field is relative to that offset', () => {
          // Arrange
          const padding = new Uint8Array(5);
          const stream = buildEwahStream(2, [
            [0x2, 0x0],
            [0x0, 0x3],
          ]);
          const bytes = concatBytes(padding, stream);
          const view = new DataView(bytes.buffer);

          // Act
          const result = readEwahStream(bytes, view, 5);

          // Assert
          expect(result).toEqual({ bitSize: 2, wordCount: 2, wordsOffset: 13, endOffset: 33 });
        });
      });
    });

    describe('Given a buffer too short for the 8-byte header', () => {
      describe('When reading the descriptor', () => {
        it("Then it refuses with check: 'stream'", () => {
          // Arrange
          const bytes = new Uint8Array(4);
          const view = new DataView(bytes.buffer);

          // Act & Assert
          expectRefusal(() => readEwahStream(bytes, view, 0), 'stream', 'truncated');
        });
      });
    });

    describe('Given a buffer holding the 8-byte header and not one byte more', () => {
      describe('When reading the descriptor', () => {
        it('Then the header itself is accepted and only the words it declares are refused', () => {
          // Arrange: the exact boundary — the header fits, so the refusal has
          // to come from the declared words overrunning, never from the
          // header being called truncated.
          const bytes = new Uint8Array(8);
          const view = new DataView(bytes.buffer);

          // Act & Assert
          expectRefusal(() => readEwahStream(bytes, view, 0), 'stream', 'overruns');
        });
      });
    });

    describe('Given a wordCount that overruns the remaining buffer by one word', () => {
      describe('When reading the descriptor', () => {
        it("Then it refuses with check: 'stream'", () => {
          // Arrange
          const bytes = pokeWordCount(buildEwahStream(0, [[0x0, 0x0]]), 2);
          const view = new DataView(bytes.buffer);

          // Act & Assert
          expectRefusal(() => readEwahStream(bytes, view, 0), 'stream', 'overruns');
        });
      });
    });

    describe('Given wordCount = 0x7fffffff', () => {
      describe('When reading the descriptor', () => {
        it("Then it refuses with check: 'stream'", () => {
          // Arrange
          const bytes = pokeWordCount(buildEwahStream(0, [[0x0, 0x0]]), 0x7fffffff);
          const view = new DataView(bytes.buffer);

          // Act & Assert
          expectRefusal(() => readEwahStream(bytes, view, 0), 'stream', 'overruns');
        });
      });
    });

    describe('Given a stream whose trailing position word falls past the end', () => {
      describe('When reading the descriptor', () => {
        it("Then it refuses with check: 'stream'", () => {
          // Arrange: all wordCount words fit; only the trailing 4-byte
          // position word is missing.
          const bytes = buildEwahStream(0, [[0x0, 0x0]]).slice(0, 16);
          const view = new DataView(bytes.buffer);

          // Act & Assert
          expectRefusal(() => readEwahStream(bytes, view, 0), 'stream', 'overruns');
        });
      });
    });
  });

  describe('encodeEwah', () => {
    describe('Given a sparse bit set with a wide gap between two literal words', () => {
      describe('When encoding', () => {
        it('Then the produced stream contains at least one clean run', () => {
          // Arrange
          const bytes = encodeEwah([0, 200], 256);

          // Act
          const cleanCounts = runLengthWordCleanCounts(bytes);

          // Assert
          expect(cleanCounts.some((count) => count > 0)).toBe(true);
        });
      });
    });
  });

  describe('foldEwahStream', () => {
    describe("Given Pin C's three type streams", () => {
      describe('When folding into a single-lane destination', () => {
        it.each<{
          name: string;
          bitSize: number;
          literal: readonly [number, number];
          expectedBits: readonly number[];
        }>([
          { name: 'commits', bitSize: 2, literal: [0x0, 0x3], expectedBits: [0, 1] },
          { name: 'trees', bitSize: 11, literal: [0x0, 0x700], expectedBits: [8, 9, 10] },
          {
            name: 'blobs',
            bitSize: 12,
            literal: [0x0, 0x8fc],
            expectedBits: [2, 3, 4, 5, 6, 7, 11],
          },
        ])('Then $name decodes to the measured bits', ({ bitSize, literal, expectedBits }) => {
          // Arrange
          const bytes = buildEwahStream(bitSize, [[0x2, 0x0], literal]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(1);

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(bitsOf(into)).toEqual([...expectedBits]);
        });
      });
    });

    describe('Given a literal-only stream spanning two words', () => {
      describe('When folding', () => {
        it('Then both literal words land at their own lane pair', () => {
          // Arrange: RLW(runValue=0, cleanCount=0, literalCount=2), then two
          // literal words each setting local bit 0.
          const bytes = buildEwahStream(128, [
            [0x4, 0x0],
            [0x0, 0x1],
            [0x0, 0x1],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(4);

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(bitsOf(into)).toEqual([0, 64]);
        });
      });
    });

    describe('Given a run-of-zeros stream followed by one literal word', () => {
      describe('When folding', () => {
        it('Then the clean lanes stay zero and the literal lands past them', () => {
          // Arrange: RLW(runValue=0, cleanCount=3, literalCount=1) skips 6
          // lanes (3 words), then one literal word sets local bit 0.
          const bytes = buildEwahStream(256, [
            [0x2, 0x6],
            [0x0, 0x1],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(8);

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(bitsOf(into)).toEqual([192]);
        });
      });
    });

    describe('Given a clean run of ones that exactly fills the destination', () => {
      describe('When folding', () => {
        it('Then every lane is set, and the run really is exactly as wide as the destination', () => {
          // Arrange: RLW(runValue=1, cleanCount=2, literalCount=0) needs
          // exactly 4 lanes.
          const bytes = buildEwahStream(128, [[0x0, 0x5]]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(4);

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(into).toEqual(new Uint32Array(4).fill(0xffffffff));
          // The UNCLAMPED walk proves "exactly fills": a run wider than the
          // destination would be clamped away and leave the fold assertion
          // above green regardless.
          expect(maxSetBitPosition(bytes, view, stream)).toBe(127);
        });
      });
    });

    describe('Given a clean run of ones one lane longer than the destination', () => {
      describe('When folding', () => {
        it('Then the write is clamped, not thrown, and the run really does reach past the destination', () => {
          // Arrange: the same 4-lane run, into a 3-lane destination.
          const bytes = buildEwahStream(128, [[0x0, 0x5]]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(3);

          // Act
          const act = (): void => foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(act).not.toThrow();
          expect(into).toEqual(new Uint32Array(3).fill(0xffffffff));
          // 127 is lane 3's last bit — one lane past this destination's end,
          // which is what makes the clamp the reason the fold stopped.
          expect(maxSetBitPosition(bytes, view, stream)).toBe(127);
        });
      });
    });

    describe('Given a run-length word declaring 0xffffffff clean words of value 1', () => {
      describe('When folding into a small destination', () => {
        it('Then the call returns well inside the default timeout, fills the destination, and writes nothing past it', () => {
          // Arrange: runValue=1, cleanCount=0xffffffff, literalCount=0.
          const bytes = buildEwahStream(0, [[0x1, 0xffffffff]]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(4);
          const startedAt = Date.now();

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');
          const elapsedMs = Date.now() - startedAt;

          // Assert
          expect(into).toEqual(new Uint32Array(4).fill(0xffffffff));
          // The run declared here really is 2^32−1 clean words wide — so the
          // clamp, not a small count, is why the fold returned at all.
          expect(maxSetBitPosition(bytes, view, stream)).toBe(0xffffffff * 64 - 1);
          expect(elapsedMs).toBeLessThan(1000);
        });
      });
    });

    describe('Given a run-length word declaring more literal words than the stream carries', () => {
      describe('When folding', () => {
        it('Then it stops at the last word the buffer backs, folding it and nothing past it', () => {
          // Arrange: RLW(runValue=0, cleanCount=0, literalCount=2) followed by
          // ONE literal word — the inner walk runs out of stream before it
          // runs out of declared literals, and only its own word-limit
          // terminator ends it (reading a second word would fall off the
          // buffer).
          const bytes = buildEwahStream(128, [
            [0x4, 0x0],
            [0x0, 0x1],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(4);

          // Act
          const act = (): void => foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(act).not.toThrow();
          expect(bitsOf(into)).toEqual([0]);
        });
      });
    });

    describe('Given a stream folded with the or operation into a pre-set destination', () => {
      describe('When folding', () => {
        it("Then existing bits are kept and the stream's bits are added", () => {
          // Arrange: commits stream (bits 0, 1) folded into a destination
          // that already has bit 2 set.
          const bytes = buildEwahStream(2, [
            [0x2, 0x0],
            [0x0, 0x3],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(1);
          into[0] = 0b100;

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(into[0]).toBe(0b111);
        });
      });
    });

    describe('Given a stream folded with the or operation over a bit the destination already carries', () => {
      describe('When folding', () => {
        it('Then the overlapping bit stays set, which xor would have cleared', () => {
          // Arrange: commits stream (bits 0, 1) folded into a destination that
          // already carries bit 0 — the one destination state that tells the
          // two operations apart.
          const bytes = buildEwahStream(2, [
            [0x2, 0x0],
            [0x0, 0x3],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(1);
          into[0] = 0b001;

          // Act
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(into[0]).toBe(0b011);
        });
      });
    });

    describe('Given a descriptor declaring far more words than the buffer backs', () => {
      describe('When folding', () => {
        it('Then the walk stops at the last word the buffer really carries, without a read past its end', () => {
          // Arrange: the shape `readEwahStream` refuses outright, so it can
          // only reach the decoder hand-built — the buffer backs two words and
          // the descriptor claims 0x7fffffff.
          const bytes = buildEwahStream(128, [
            [0x4, 0x0],
            [0x0, 0x1],
          ]);
          const view = new DataView(bytes.buffer);
          const stream: EwahStream = {
            bitSize: 128,
            wordCount: 0x7fffffff,
            wordsOffset: 8,
            endOffset: bytes.length,
          };
          const into = new Uint32Array(4);

          // Act
          const act = (): void => foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(act).not.toThrow();
          expect(bitsOf(into)).toEqual([0]);
        });
      });
    });

    describe('Given the same stream folded with xor twice', () => {
      describe('When folding', () => {
        it('Then the destination returns to its original value', () => {
          // Arrange
          const bytes = buildEwahStream(2, [
            [0x2, 0x0],
            [0x0, 0x3],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(1);

          // Act
          foldEwahStream(bytes, view, stream, into, 'xor');
          const afterFirst = into[0];
          foldEwahStream(bytes, view, stream, into, 'xor');

          // Assert
          expect(afterFirst).toBe(0b11);
          expect(into[0]).toBe(0);
        });
      });
    });
  });

  describe('maxSetBitPosition', () => {
    describe('Given hand-crafted streams covering every run-length shape', () => {
      describe('When the highest set bit is read without folding', () => {
        it.each<{
          label: string;
          bitSize: number;
          words: ReadonlyArray<readonly [number, number]>;
          expected: number;
        }>([
          { label: 'the empty stream', bitSize: 0, words: [[0x0, 0x0]], expected: -1 },
          {
            label: 'a literal word setting bits 0 and 1',
            bitSize: 2,
            words: [
              [0x2, 0x0],
              [0x0, 0x3],
            ],
            expected: 1,
          },
          {
            label: "a literal word setting only its HIGH half's bit 0",
            bitSize: 64,
            words: [
              [0x2, 0x0],
              [0x1, 0x0],
            ],
            expected: 32,
          },
          {
            label: 'a clean run of ones spanning two 64-bit words',
            bitSize: 128,
            words: [[0x0, 0x5]],
            expected: 127,
          },
          {
            label: 'a run of ones declaring ZERO clean words after a skipped run',
            bitSize: 128,
            words: [
              [0x0, 0x2],
              [0x0, 0x1],
            ],
            expected: -1,
          },
          {
            label: 'a clean run of zeros followed by one literal word',
            bitSize: 256,
            words: [
              [0x2, 0x6],
              [0x0, 0x1],
            ],
            expected: 192,
          },
          {
            label: 'a literal count larger than the words the stream actually carries',
            bitSize: 128,
            words: [
              [0x4, 0x0],
              [0x0, 0x1],
            ],
            expected: 0,
          },
          {
            // Two literal words each setting their OWN local bit 0: only a
            // forward lane advance across the pair puts the answer at 64.
            label: 'two literal words whose later one carries the higher bit',
            bitSize: 128,
            words: [
              [0x4, 0x0],
              [0x0, 0x1],
              [0x0, 0x1],
            ],
            expected: 64,
          },
        ])('Then $label reports its own highest bit', ({ bitSize, words, expected }) => {
          // Arrange
          const bytes = buildEwahStream(bitSize, words);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const sut = maxSetBitPosition;

          // Act
          const result = sut(bytes, view, stream);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe('Given a stream whose only set bit lies far past any destination a fold would allocate', () => {
      describe('When the highest set bit is read', () => {
        it('Then it is observed rather than truncated, unlike the clamped fold', () => {
          // Arrange: 1000 clean-zero words (2000 lanes) then one literal
          // word setting its own local bit 0.
          const bytes = buildEwahStream(64_064, [
            [0x2, 1000 << 1],
            [0x0, 0x1],
          ]);
          const view = new DataView(bytes.buffer);
          const stream = readEwahStream(bytes, view, 0);
          const into = new Uint32Array(4);
          const sut = maxSetBitPosition;

          // Act
          const result = sut(bytes, view, stream);
          foldEwahStream(bytes, view, stream, into, 'or');

          // Assert
          expect(result).toBe(64_000);
          expect(bitsOf(into)).toEqual([]);
        });
      });
    });
  });

  describe('BitmapCheck exhaustiveness', () => {
    describe('Given every member of the BitmapCheck union', () => {
      describe('When each is run through an exhaustive switch', () => {
        it.each<BitmapCheck>(['size', 'signature', 'version', 'options', 'stream', 'entry'])(
          'Then %s is handled',
          (check) => {
            // Arrange & Act & Assert
            assertExhaustiveBitmapCheck(check);
          },
        );
      });
    });
  });
});

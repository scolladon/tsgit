import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { bitmapEntryHeaders, parsePackBitmap } from '../../../../src/domain/storage/bitmap.js';
import type { BitmapCheck } from '../../../../src/domain/storage/error.js';
import { type BitmapEntrySpec, type BitmapSpec, buildBitmap, encodeEwah } from './arbitraries.js';

// --- Fixture helpers -------------------------------------------------------

const HEADER_SIZE = 12;
const ENTRY_FIXED_SIZE = 6;

function baseSpec(overrides: Partial<BitmapSpec> = {}): BitmapSpec {
  return {
    optionFlags: 0x0005,
    digestLength: 20,
    checksum: new Uint8Array(20).fill(0xaa),
    typeStreams: [
      { bits: [0, 1], bitSize: 2 },
      { bits: [8, 9, 10], bitSize: 11 },
      { bits: [2, 3, 4, 5, 6, 7, 11], bitSize: 12 },
      { bits: [], bitSize: 0 },
    ],
    entries: [
      { position: 5, xorOffset: 0, flags: 0, bits: [0, 1], bitSize: 12 },
      { position: 9, xorOffset: 1, flags: 0, bits: [2], bitSize: 12 },
    ],
    trailingBytes: 0,
    ...overrides,
  };
}

function withEntries(entries: ReadonlyArray<BitmapEntrySpec>): BitmapSpec {
  return baseSpec({ entries });
}

/** Byte offsets a well-formed spec's own layout implies, recomputed from
 *  `encodeEwah`'s output lengths rather than from the parser under test —
 *  the offsets a refusal fixture needs to poke or truncate at. */
function streamOffsets(spec: BitmapSpec): {
  readonly commitsStart: number;
  readonly tagsStart: number;
  readonly entriesOffset: number;
} {
  const commitsStart = HEADER_SIZE + spec.digestLength;
  const [commits, trees, blobs, tags] = spec.typeStreams;
  const treesStart = commitsStart + encodeEwah(commits.bits, commits.bitSize).length;
  const blobsStart = treesStart + encodeEwah(trees.bits, trees.bitSize).length;
  const tagsStart = blobsStart + encodeEwah(blobs.bits, blobs.bitSize).length;
  const entriesOffset = tagsStart + encodeEwah(tags.bits, tags.bitSize).length;
  return { commitsStart, tagsStart, entriesOffset };
}

function pokeMagic(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[3] = copy[3]! ^ 0xff;
  return copy;
}

function pokeVersion(bytes: Uint8Array, version: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(4, version);
  return copy;
}

function pokeFlags(bytes: Uint8Array, flags: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(6, flags);
  return copy;
}

function pokeWordCountAt(
  bytes: Uint8Array,
  wordCountOffset: number,
  wordCount: number,
): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(wordCountOffset, wordCount);
  return copy;
}

function truncate(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.slice(0, length);
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

// --- Tests -------------------------------------------------------------

describe('bitmap', () => {
  describe('parsePackBitmap', () => {
    describe('Given a well-formed bitmap (the Pin D 12-object shape)', () => {
      describe('When parsing', () => {
        it('Then version, optionFlags, entryCount, digestLength, checksum, all four typeStreams and entriesOffset equal the spec', () => {
          // Arrange
          const spec = baseSpec();
          const sut = parsePackBitmap;
          const offsets = streamOffsets(spec);

          // Act
          const result = sut(buildBitmap(spec), spec.digestLength);

          // Assert
          expect(result.version).toBe(1);
          expect(result.optionFlags).toBe(spec.optionFlags);
          expect(result.entryCount).toBe(spec.entries.length);
          expect(result.digestLength).toBe(spec.digestLength);
          expect(result.checksum).toEqual(spec.checksum);
          expect(result.typeStreams.map((stream) => stream.bitSize)).toEqual(
            spec.typeStreams.map((stream) => stream.bitSize),
          );
          expect(result.typeStreams[0].wordsOffset).toBe(offsets.commitsStart + 8);
          expect(result.typeStreams[3].endOffset).toBe(offsets.entriesOffset);
          expect(result.entriesOffset).toBe(offsets.entriesOffset);
        });
      });
    });

    describe('Given a bitmap whose tags stream is empty', () => {
      describe('When parsing', () => {
        it('Then the tags stream is 20 bytes, not 12: bitSize 0 and wordCount 1', () => {
          // Arrange
          const spec = baseSpec();
          const sut = parsePackBitmap;

          // Act
          const result = sut(buildBitmap(spec), spec.digestLength);
          const [, , , tags] = result.typeStreams;

          // Assert
          expect(tags.bitSize).toBe(0);
          expect(tags.wordCount).toBe(1);
          expect(tags.endOffset - (tags.wordsOffset - 8)).toBe(20);
        });
      });
    });

    describe('Given the same shape parsed with digestLength 20 versus 32', () => {
      describe('When parsing', () => {
        it('Then entriesOffset shifts by exactly the digest-width difference — the only width-dependent offset', () => {
          // Arrange
          const spec20 = baseSpec({ digestLength: 20, checksum: new Uint8Array(20).fill(0xaa) });
          const spec32 = baseSpec({ digestLength: 32, checksum: new Uint8Array(32).fill(0xaa) });
          const sut = parsePackBitmap;

          // Act
          const result20 = sut(buildBitmap(spec20), 20);
          const result32 = sut(buildBitmap(spec32), 32);

          // Assert
          expect(result32.checksum.length).toBe(32);
          expect(result32.entriesOffset - result20.entriesOffset).toBe(32 - 20);
        });
      });
    });

    describe('Given every flag word git 2.55.0 is known to write', () => {
      describe('When parsing', () => {
        it.each([
          { flagWord: 0x0001, label: '0x0001' },
          { flagWord: 0x0005, label: '0x0005' },
          { flagWord: 0x0015, label: '0x0015' },
          { flagWord: 0x0025, label: '0x0025' },
        ])('Then flag word $label is accepted', ({ flagWord }) => {
          // Arrange
          const spec = baseSpec({ optionFlags: flagWord });
          const sut = parsePackBitmap;

          // Act
          const result = sut(buildBitmap(spec), spec.digestLength);

          // Assert
          expect(result.optionFlags).toBe(flagWord);
        });

        it('Then entriesOffset is identical under all four — every flag-selected extension is trailing', () => {
          // Arrange
          const flagWords = [0x0001, 0x0005, 0x0015, 0x0025];
          const sut = parsePackBitmap;

          // Act
          const entriesOffsets = flagWords.map(
            (flagWord) => sut(buildBitmap(baseSpec({ optionFlags: flagWord })), 20).entriesOffset,
          );

          // Assert
          expect(new Set(entriesOffsets).size).toBe(1);
        });
      });
    });

    describe('Given a file one byte short of the minimum header size', () => {
      describe('When parsing', () => {
        it('Then refuses with size', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = truncate(buildBitmap(spec), HEADER_SIZE + spec.digestLength - 1);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'size', 'truncated');
        });
      });
    });

    describe('Given a bitmap with the magic bytes flipped', () => {
      describe('When parsing', () => {
        it('Then refuses with signature', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeMagic(buildBitmap(spec));

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'signature', 'signature');
        });
      });
    });

    describe('Given a bitmap with version 0', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeVersion(buildBitmap(spec), 0);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'version', 'version');
        });
      });
    });

    describe('Given a bitmap with version 2', () => {
      describe('When parsing', () => {
        it('Then refuses with version — there is no v2', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeVersion(buildBitmap(spec), 2);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'version', 'version');
        });
      });
    });

    describe('Given a bitmap with option flags 0x0000', () => {
      describe('When parsing', () => {
        it('Then refuses with options — the mandatory full-DAG bit is unset', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeFlags(buildBitmap(spec), 0x0000);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'options', 'full-DAG');
        });
      });
    });

    describe('Given a bitmap with option flags 0x0004 (a set bit that is not full-DAG)', () => {
      describe('When parsing', () => {
        it('Then refuses with options', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeFlags(buildBitmap(spec), 0x0004);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'options', 'full-DAG');
        });
      });
    });

    describe('Given the commits stream declares a wordCount that overruns the buffer', () => {
      describe('When parsing', () => {
        it("Then refuses with check: 'stream'", () => {
          // Arrange
          const spec = baseSpec();
          const offsets = streamOffsets(spec);
          const bytes = pokeWordCountAt(buildBitmap(spec), offsets.commitsStart + 4, 0x7fffffff);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'stream', 'overruns');
        });
      });
    });

    describe('Given the buffer ends before the tags stream descriptor fits', () => {
      describe('When parsing', () => {
        it("Then refuses with check: 'stream'", () => {
          // Arrange
          const spec = baseSpec();
          const offsets = streamOffsets(spec);
          const bytes = truncate(buildBitmap(spec), offsets.tagsStart + 4);

          // Act & Assert
          expectRefusal(() => parsePackBitmap(bytes, spec.digestLength), 'stream', 'truncated');
        });
      });
    });
  });

  describe('bitmapEntryHeaders', () => {
    describe('Given a file that ends inside an entry header’s fixed 6 bytes', () => {
      describe('When walking entry headers', () => {
        it("Then refuses with check: 'entry'", () => {
          // Arrange
          const spec = withEntries([
            { position: 5, xorOffset: 0, flags: 0, bits: [0], bitSize: 4 },
          ]);
          const offsets = streamOffsets(spec);
          const bytes = truncate(buildBitmap(spec), offsets.entriesOffset + 3);
          const bitmap = parsePackBitmap(bytes, spec.digestLength);

          // Act & Assert
          expectRefusal(() => bitmapEntryHeaders(bitmap), 'entry', 'extends past end of file');
        });
      });
    });

    describe('Given an entry whose embedded stream declares a wordCount that overruns the buffer', () => {
      describe('When walking entry headers', () => {
        it("Then refuses with check: 'entry'", () => {
          // Arrange
          const spec = withEntries([
            { position: 5, xorOffset: 0, flags: 0, bits: [0], bitSize: 4 },
          ]);
          const offsets = streamOffsets(spec);
          const wordCountOffset = offsets.entriesOffset + ENTRY_FIXED_SIZE + 4;
          const bytes = pokeWordCountAt(buildBitmap(spec), wordCountOffset, 0x7fffffff);
          const bitmap = parsePackBitmap(bytes, spec.digestLength);

          // Act & Assert
          expectRefusal(() => bitmapEntryHeaders(bitmap), 'entry', 'invalid embedded stream');
        });
      });
    });

    describe('Given a second entry whose xorOffset refers to a later entry', () => {
      describe('When walking entry headers', () => {
        it("Then refuses with check: 'entry'", () => {
          // Arrange
          const spec = withEntries([
            { position: 1, xorOffset: 0, flags: 0, bits: [0], bitSize: 4 },
            { position: 2, xorOffset: 2, flags: 0, bits: [1], bitSize: 4 },
          ]);
          const bitmap = parsePackBitmap(buildBitmap(spec), spec.digestLength);

          // Act & Assert
          expectRefusal(() => bitmapEntryHeaders(bitmap), 'entry', 'has not been parsed yet');
        });
      });
    });

    describe('Given the first entry has a non-zero xorOffset', () => {
      describe('When walking entry headers', () => {
        it("Then refuses with check: 'entry' — the base must precede, and entry 0 has no predecessor", () => {
          // Arrange
          const spec = withEntries([
            { position: 5, xorOffset: 1, flags: 0, bits: [0], bitSize: 4 },
          ]);
          const bitmap = parsePackBitmap(buildBitmap(spec), spec.digestLength);

          // Act & Assert
          expectRefusal(() => bitmapEntryHeaders(bitmap), 'entry', 'has not been parsed yet');
        });
      });
    });

    describe('Given a second entry whose xorOffset equals its own index', () => {
      describe('When walking entry headers', () => {
        it('Then it accepts — the base is exactly the preceding entry', () => {
          // Arrange
          const spec = withEntries([
            { position: 1, xorOffset: 0, flags: 0, bits: [0], bitSize: 4 },
            { position: 2, xorOffset: 1, flags: 0, bits: [1], bitSize: 4 },
          ]);
          const bitmap = parsePackBitmap(buildBitmap(spec), spec.digestLength);

          // Act
          const result = bitmapEntryHeaders(bitmap);

          // Assert
          expect(result.map((h) => h.xorOffset)).toEqual([0, 1]);
        });
      });
    });

    describe('Given a bitmap with zero entries', () => {
      describe('When walking entry headers', () => {
        it('Then it returns an empty array', () => {
          // Arrange
          const spec = withEntries([]);
          const bitmap = parsePackBitmap(buildBitmap(spec), spec.digestLength);

          // Act
          const result = bitmapEntryHeaders(bitmap);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a 3-entry file with xorOffsets {0, 1, 1}', () => {
      describe('When walking entry headers', () => {
        it("Then bitmapEntryHeaders returns the spec's positions, offsets, flags and stream bounds", () => {
          // Arrange
          const spec = withEntries([
            { position: 10, xorOffset: 0, flags: 1, bits: [0], bitSize: 8 },
            { position: 20, xorOffset: 1, flags: 2, bits: [1, 2], bitSize: 8 },
            { position: 30, xorOffset: 1, flags: 3, bits: [3], bitSize: 8 },
          ]);
          const bitmap = parsePackBitmap(buildBitmap(spec), spec.digestLength);

          // Act
          const result = bitmapEntryHeaders(bitmap);

          // Assert
          expect(result.map((h) => h.position)).toEqual([10, 20, 30]);
          expect(result.map((h) => h.xorOffset)).toEqual([0, 1, 1]);
          expect(result.map((h) => h.flags)).toEqual([1, 2, 3]);
          expect(result.map((h) => h.stream.bitSize)).toEqual([8, 8, 8]);
          expect(result[1]!.stream.wordsOffset).toBeGreaterThan(result[0]!.stream.endOffset - 8);
          expect(result[2]!.stream.wordsOffset).toBeGreaterThan(result[1]!.stream.endOffset - 8);
        });
      });
    });

    describe('Given an entry header naming position 999999 in a 12-object shape', () => {
      describe('When walking entry headers', () => {
        it('Then it parses, position comes back as 999999, and the range check is left to the consumer that knows the object count', () => {
          // Arrange
          const spec = withEntries([
            { position: 999999, xorOffset: 0, flags: 0, bits: [0], bitSize: 4 },
          ]);
          const bitmap = parsePackBitmap(buildBitmap(spec), spec.digestLength);

          // Act
          const result = bitmapEntryHeaders(bitmap);

          // Assert
          expect(result[0]!.position).toBe(999999);
        });
      });
    });

    describe('Given the same entries with 6424 trailing bytes appended', () => {
      describe('When parsing and walking entry headers', () => {
        it('Then it parses identically and entriesOffset is unchanged', () => {
          // Arrange
          const spec = baseSpec();
          const tailedSpec = { ...spec, trailingBytes: 6424 };

          // Act
          const bare = parsePackBitmap(buildBitmap(spec), spec.digestLength);
          const tailed = parsePackBitmap(buildBitmap(tailedSpec), spec.digestLength);

          // Assert
          expect(tailed.entriesOffset).toBe(bare.entriesOffset);
          expect(bitmapEntryHeaders(tailed)).toEqual(bitmapEntryHeaders(bare));
        });
      });
    });
  });
});

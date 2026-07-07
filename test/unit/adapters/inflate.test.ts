import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflateZlibMember } from '../../../src/adapters/inflate.js';
import { TsgitError } from '../../../src/domain/index.js';

const ZLIB_CMF_CM8_CINFO7 = 0x78;
const FCHECK_MOD = 31;
const FCHECK_SEARCH_LIMIT = 32;
const FDICT_SHIFT = 5;

const FIRST_BLOCK_BYTE_INDEX = 2;
const BTYPE_BIT_OFFSET = 1;
const BTYPE_MASK = 0b11;
const FIXED_BLOCK_TYPE = 1;
const DYNAMIC_BLOCK_TYPE = 2;

/** RFC 1951 order in which code-length code lengths are transmitted. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const CL_SYMBOL_ZERO_POSITION = CL_ORDER.indexOf(0);
const CL_SYMBOL_ONE_POSITION = CL_ORDER.indexOf(1);
const CL_SYMBOL_SIXTEEN_POSITION = CL_ORDER.indexOf(16);
const CL_SYMBOL_EIGHTEEN_POSITION = CL_ORDER.indexOf(18);
const HLIT_BASE = 257;
const HDIST_BASE = 1;
const HCLEN_MINIMUM = 4;
const HLIT_FIELD_BITS = 5;
const HDIST_FIELD_BITS = 5;
const HCLEN_FIELD_BITS = 4;
const CL_LENGTH_FIELD_BITS = 3;
const REPEAT_ZERO_LONG_EXTRA_BITS = 7;

/** Number of HCLEN entries needed so the code-length alphabet covers both
 * CL-symbol 0 and CL-symbol 1 (whichever RFC-order position comes later). */
const HCLEN_COVERING_ZERO_AND_ONE = Math.max(CL_SYMBOL_ZERO_POSITION, CL_SYMBOL_ONE_POSITION) + 1;

/** Read BFINAL/BTYPE from the first block-header byte of a zlib member. */
function readFirstBlockType(member: Uint8Array): number {
  return ((member[FIRST_BLOCK_BYTE_INDEX] as number) >> BTYPE_BIT_OFFSET) & BTYPE_MASK;
}

/**
 * LSB-first bit writer for hand-crafting raw DEFLATE block bytes in tests.
 * `writeField` packs a value LSB-first (matches BFINAL/BTYPE/extra-bit fields);
 * `writeCode` packs an RFC-documented MSB-first Huffman code bit string.
 */
class TestBitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private bitCount = 0;

  writeField(value: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.pushBit((value >> i) & 1);
    }
  }

  writeCode(msbFirstBits: string): void {
    for (const bit of msbFirstBits) {
      this.pushBit(bit === '1' ? 1 : 0);
    }
  }

  toBytes(): Uint8Array {
    if (this.bitCount > 0) this.bytes.push(this.current);
    return new Uint8Array(this.bytes);
  }

  private pushBit(bit: number): void {
    this.current |= bit << this.bitCount;
    this.bitCount += 1;
    if (this.bitCount === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.bitCount = 0;
    }
  }
}

/** Build a valid (or FDICT-flagged) 2-byte zlib header for hand-crafted members. */
function buildZlibHeader(fdict: 0 | 1): [number, number] {
  const cmf = ZLIB_CMF_CM8_CINFO7;
  let flg = fdict << FDICT_SHIFT;
  for (let fcheck = 0; fcheck < FCHECK_SEARCH_LIMIT; fcheck += 1) {
    if ((cmf * 256 + flg + fcheck) % FCHECK_MOD === 0) {
      flg += fcheck;
      break;
    }
  }
  return [cmf, flg];
}

/**
 * Write a dynamic-Huffman header (HLIT/HDIST/HCLEN + code-length table +
 * combined lit/len+dist code lengths) whose code-length alphabet uses only
 * two codes: CL-symbol 0 (actual code length 0, single-bit code '0') and
 * CL-symbol 1 (actual code length 1, single-bit code '1'). Sufficient to
 * hand-craft dynamic blocks whose lit/len and distance tables only need
 * single-bit codes, without involving RLE.
 */
function writeDynamicHeader(
  writer: TestBitWriter,
  litLenLengths: ReadonlyArray<number>,
  distLengths: ReadonlyArray<number>,
): void {
  writer.writeField(litLenLengths.length - HLIT_BASE, HLIT_FIELD_BITS);
  writer.writeField(distLengths.length - HDIST_BASE, HDIST_FIELD_BITS);
  writer.writeField(HCLEN_COVERING_ZERO_AND_ONE - HCLEN_MINIMUM, HCLEN_FIELD_BITS);

  for (let position = 0; position < HCLEN_COVERING_ZERO_AND_ONE; position += 1) {
    const isUsed = position === CL_SYMBOL_ZERO_POSITION || position === CL_SYMBOL_ONE_POSITION;
    writer.writeField(isUsed ? 1 : 0, CL_LENGTH_FIELD_BITS);
  }

  for (const length of [...litLenLengths, ...distLengths]) {
    writer.writeCode(length === 0 ? '0' : '1');
  }
}

function assertDecompressFailed(act: () => unknown, expectedReason: string): void {
  let caught: unknown;
  try {
    act();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data;
  expect(data.code).toBe('DECOMPRESS_FAILED');
  if (data.code === 'DECOMPRESS_FAILED') {
    expect(data.reason).toBe(expectedReason);
  }
}

describe('inflateZlibMember', () => {
  describe('Given a level-0 (stored) zlib member', () => {
    describe('When decoding at the member start', () => {
      it('Then round-trips with byte-exact bytesConsumed', () => {
        // Arrange
        const sut = inflateZlibMember;
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        const member = deflateSync(payload, { level: 0 });

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual(Array.from(payload));
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given a stored member spanning multiple stored blocks (> 65535 bytes)', () => {
    describe('When decoding at the member start', () => {
      it('Then round-trips with byte-exact bytesConsumed', () => {
        // Arrange
        const sut = inflateZlibMember;
        const payload = new Uint8Array(randomBytes(70000));
        const member = deflateSync(payload, { level: 0 });

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual(Array.from(payload));
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given two stored zlib members concatenated', () => {
    describe('When decoding at the second member offset', () => {
      it('Then returns only the second member and its exact length', () => {
        // Arrange
        const sut = inflateZlibMember;
        const payload1 = new Uint8Array([9, 8, 7]);
        const payload2 = new Uint8Array([6, 5, 4, 3]);
        const member1 = deflateSync(payload1, { level: 0 });
        const member2 = deflateSync(payload2, { level: 0 });
        const concatenated = new Uint8Array(member1.length + member2.length);
        concatenated.set(member1, 0);
        concatenated.set(member2, member1.length);

        // Act
        const first = sut(concatenated, 0);
        const second = sut(concatenated, first.bytesConsumed);

        // Assert
        expect(first.bytesConsumed).toBe(member1.length);
        expect(Array.from(second.output)).toEqual(Array.from(payload2));
        expect(second.bytesConsumed).toBe(member2.length);
      });
    });
  });

  describe('Given a member with an unsupported compression method (CM != 8)', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the unsupported-method reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const member = deflateSync(new Uint8Array([1, 2, 3]), { level: 0 });
        const corrupted = new Uint8Array(member);
        corrupted[0] = ((corrupted[0] as number) & 0xf0) | 0x07;

        // Act & Assert
        assertDecompressFailed(() => sut(corrupted, 0), 'unsupported compression method');
      });
    });
  });

  describe('Given a member with CINFO above the maximum window size (CINFO > 7)', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-window-size reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const member = deflateSync(new Uint8Array([1, 2, 3]), { level: 0 });
        const corrupted = new Uint8Array(member);
        corrupted[0] = ((corrupted[0] as number) & 0x0f) | (8 << 4);

        // Act & Assert
        assertDecompressFailed(() => sut(corrupted, 0), 'invalid window size');
      });
    });
  });

  describe('Given a header whose FCHECK bits do not satisfy the mod-31 checksum', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-header-checksum reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const member = new Uint8Array([ZLIB_CMF_CM8_CINFO7, 0x00]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'invalid zlib header checksum');
      });
    });
  });

  describe('Given a header with FDICT set (preset dictionary)', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the preset-dictionary reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(1);
        const member = new Uint8Array([cmf, flg]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'preset dictionary not supported');
      });
    });
  });

  describe('Given a stored block whose NLEN does not complement LEN', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the length-mismatch reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const blockHeaderByte = 0x01; // BFINAL=1, BTYPE=00 (stored)
        const member = new Uint8Array([cmf, flg, blockHeaderByte, 3, 0, 0, 0]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'stored block length mismatch');
      });
    });
  });

  describe('Given a member whose adler32 trailer does not match the payload', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the checksum-mismatch reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const member = deflateSync(new Uint8Array([1, 2, 3]), { level: 0 });
        const corrupted = new Uint8Array(member);
        const lastIndex = corrupted.length - 1;
        corrupted[lastIndex] = (corrupted[lastIndex] as number) ^ 0x01;

        // Act & Assert
        assertDecompressFailed(() => sut(corrupted, 0), 'adler32 checksum mismatch');
      });
    });
  });

  describe('Given a member truncated before its adler32 trailer is complete', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the unexpected-end reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const member = deflateSync(new Uint8Array([1, 2, 3]), { level: 0 });
        const truncated = member.subarray(0, member.length - 2);

        // Act & Assert
        assertDecompressFailed(() => sut(truncated, 0), 'unexpected end of deflate stream');
      });
    });
  });

  describe('Given a block header with the reserved BTYPE (3)', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the reserved-block-type reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const blockHeaderByte = 0x07; // BFINAL=1, BTYPE=11 (reserved)
        const member = new Uint8Array([cmf, flg, blockHeaderByte]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'reserved block type');
      });
    });
  });

  describe('Given non-zlib junk bytes', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the unsupported-method reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

        // Act & Assert
        assertDecompressFailed(() => sut(junk, 0), 'unsupported compression method');
      });
    });
  });

  describe('Given the empty payload', () => {
    describe('When decoding a fixed-Huffman member with no body bytes', () => {
      it('Then round-trips to empty output with byte-exact bytesConsumed', () => {
        // Arrange
        const sut = inflateZlibMember;
        const member = deflateSync(new Uint8Array(0));
        expect(readFirstBlockType(member)).toBe(FIXED_BLOCK_TYPE);

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual([]);
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given a fixed-Huffman member with a back-reference', () => {
    describe('When decoding a short repetitive payload', () => {
      it('Then round-trips with byte-exact bytesConsumed', () => {
        // Arrange
        const sut = inflateZlibMember;
        const payload = new TextEncoder().encode('abc'.repeat(13));
        const member = deflateSync(payload);
        expect(readFirstBlockType(member)).toBe(FIXED_BLOCK_TYPE);

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual(Array.from(payload));
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given a back-reference whose distance is less than its length', () => {
    describe('When decoding a run-length payload (overlapping copy)', () => {
      it('Then the replicated bytes are byte-exact', () => {
        // Arrange
        const sut = inflateZlibMember;
        const payload = new TextEncoder().encode('a'.repeat(30));
        const member = deflateSync(payload);
        expect(readFirstBlockType(member)).toBe(FIXED_BLOCK_TYPE);

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual(Array.from(payload));
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given a fixed-Huffman back-reference whose distance exceeds the output produced so far', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the distance-exceeds-output reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(FIXED_BLOCK_TYPE, 2); // BTYPE
        writer.writeCode('0000001'); // lit/len symbol 257 (length base 3, 0 extra bits)
        writer.writeCode('00000'); // distance symbol 0 (distance base 1, 0 extra bits)
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'distance exceeds output');
      });
    });
  });

  describe('Given a fixed-Huffman length symbol that is reserved (286)', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-length-code reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(FIXED_BLOCK_TYPE, 2); // BTYPE
        writer.writeCode('11000110'); // lit/len symbol 286 (reserved, never emitted)
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'invalid length code');
      });
    });
  });
  describe('Given a dynamic-Huffman member', () => {
    describe('When decoding a larger structured payload', () => {
      it('Then round-trips with byte-exact bytesConsumed', () => {
        // Arrange
        const sut = inflateZlibMember;
        const lines = Array.from(
          { length: 60 },
          (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog ${i * 7}`,
        ).join('\n');
        const payload = new TextEncoder().encode(lines);
        const member = deflateSync(payload);
        expect(readFirstBlockType(member)).toBe(DYNAMIC_BLOCK_TYPE);

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual(Array.from(payload));
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given a payload with a back-reference near the 32 KiB window boundary', () => {
    describe('When decoding', () => {
      it('Then round-trips with byte-exact bytesConsumed', () => {
        // Arrange
        const sut = inflateZlibMember;
        const repeatedSlice = new Uint8Array(randomBytes(4096));
        const gapFiller = new Uint8Array(randomBytes(28000));
        const payload = new Uint8Array(repeatedSlice.length * 2 + gapFiller.length);
        payload.set(repeatedSlice, 0);
        payload.set(gapFiller, repeatedSlice.length);
        payload.set(repeatedSlice, repeatedSlice.length + gapFiller.length);
        const member = deflateSync(payload);

        // Act
        const result = sut(member, 0);

        // Assert
        expect(Array.from(result.output)).toEqual(Array.from(payload));
        expect(result.bytesConsumed).toBe(member.length);
      });
    });
  });

  describe('Given a dynamic code-length run that repeats a previous length before any length exists', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the no-previous-length reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(DYNAMIC_BLOCK_TYPE, 2); // BTYPE
        writer.writeField(0, HLIT_FIELD_BITS); // HLIT = 257
        writer.writeField(0, HDIST_FIELD_BITS); // HDIST = 1
        writer.writeField(0, HCLEN_FIELD_BITS); // HCLEN = 4 (covers CL_ORDER[0..3])
        for (let position = 0; position < HCLEN_MINIMUM; position += 1) {
          const isSixteen = position === CL_SYMBOL_SIXTEEN_POSITION;
          writer.writeField(isSixteen ? 1 : 0, CL_LENGTH_FIELD_BITS);
        }
        writer.writeCode('0'); // CL symbol 16 (repeat-previous) as the very first code length
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'code-length repeat with no previous length');
      });
    });
  });

  describe('Given a dynamic code-length run that overflows the declared HLIT+HDIST count', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-code-length-run reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(DYNAMIC_BLOCK_TYPE, 2); // BTYPE
        writer.writeField(0, HLIT_FIELD_BITS); // HLIT = 257
        writer.writeField(0, HDIST_FIELD_BITS); // HDIST = 1 (declared total = 258)
        writer.writeField(0, HCLEN_FIELD_BITS); // HCLEN = 4 (covers CL_ORDER[0..3])
        for (let position = 0; position < HCLEN_MINIMUM; position += 1) {
          const isEighteen = position === CL_SYMBOL_EIGHTEEN_POSITION;
          writer.writeField(isEighteen ? 1 : 0, CL_LENGTH_FIELD_BITS);
        }
        const maxRepeatExtra = (1 << REPEAT_ZERO_LONG_EXTRA_BITS) - 1; // repeat = 138 (max)
        writer.writeCode('0'); // CL symbol 18 (repeat-zero-long): repeat 138
        writer.writeField(maxRepeatExtra, REPEAT_ZERO_LONG_EXTRA_BITS);
        writer.writeCode('0'); // CL symbol 18 again: repeat 138 more (138 + 138 > 258)
        writer.writeField(maxRepeatExtra, REPEAT_ZERO_LONG_EXTRA_BITS);
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'invalid code-length run');
      });
    });
  });

  describe('Given a dynamic block whose distance table declares a reserved distance code (30)', () => {
    describe('When decoding a length/distance pair that selects it', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-distance-code reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(DYNAMIC_BLOCK_TYPE, 2); // BTYPE

        const litLenLengths = new Array(HLIT_BASE + 1).fill(0); // symbols 0..257
        litLenLengths[256] = 1; // end-of-block
        litLenLengths[257] = 1; // length symbol (base 3, 0 extra bits)
        const distLengths = new Array(31).fill(0); // symbols 0..30
        distLengths[30] = 1; // reserved distance code
        writeDynamicHeader(writer, litLenLengths, distLengths);

        writer.writeCode('1'); // lit/len symbol 257 (length code)
        writer.writeCode('0'); // distance symbol 30 (reserved)
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'invalid distance code');
      });
    });
  });

  describe('Given a dynamic literal/length table with an incomplete (unused) code point', () => {
    describe('When the bitstream selects the unused 15-bit-deep code', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-huffman-code reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(DYNAMIC_BLOCK_TYPE, 2); // BTYPE

        const litLenLengths = new Array(HLIT_BASE).fill(0); // symbols 0..256, only symbol 0 used
        litLenLengths[0] = 1; // single 1-bit code ('0'); '1' is left unused (incomplete table)
        const distLengths = [1]; // trivially valid single-symbol distance table
        writeDynamicHeader(writer, litLenLengths, distLengths);

        // The block body's first symbol read walks the incomplete table: feed the
        // unused code ('1') then 14 more bits. Every remaining length has zero
        // codes, so no match is ever found and the walk exhausts all 15 lengths.
        writer.writeCode(`1${'0'.repeat(14)}`);
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'invalid huffman code');
      });
    });
  });

  describe('Given a dynamic block whose code-length table over-subscribes the Huffman code space', () => {
    describe('When decoding', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-code-lengths reason', () => {
        // Arrange
        const sut = inflateZlibMember;
        const [cmf, flg] = buildZlibHeader(0);
        const writer = new TestBitWriter();
        writer.writeField(1, 1); // BFINAL
        writer.writeField(DYNAMIC_BLOCK_TYPE, 2); // BTYPE
        writer.writeField(0, HLIT_FIELD_BITS); // HLIT = 257
        writer.writeField(0, HDIST_FIELD_BITS); // HDIST = 1
        writer.writeField(0, HCLEN_FIELD_BITS); // HCLEN = 4

        // Three length-1 code-length codes: over-subscribed (only two fit).
        writer.writeField(1, CL_LENGTH_FIELD_BITS); // CL symbol 16
        writer.writeField(1, CL_LENGTH_FIELD_BITS); // CL symbol 17
        writer.writeField(1, CL_LENGTH_FIELD_BITS); // CL symbol 18
        writer.writeField(0, CL_LENGTH_FIELD_BITS); // CL symbol 0
        const member = new Uint8Array([cmf, flg, ...writer.toBytes()]);

        // Act & Assert
        assertDecompressFailed(() => sut(member, 0), 'invalid huffman code lengths');
      });
    });
  });
});

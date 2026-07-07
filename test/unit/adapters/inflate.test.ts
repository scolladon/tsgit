import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildHuffmanTable, inflateZlibMember } from '../../../src/adapters/inflate.js';
import { TsgitError } from '../../../src/domain/index.js';

const ZLIB_CMF_CM8_CINFO7 = 0x78;
const FCHECK_MOD = 31;
const FCHECK_SEARCH_LIMIT = 32;
const FDICT_SHIFT = 5;

const FIRST_BLOCK_BYTE_INDEX = 2;
const BTYPE_BIT_OFFSET = 1;
const BTYPE_MASK = 0b11;
const FIXED_BLOCK_TYPE = 1;

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
});

describe('buildHuffmanTable', () => {
  describe('Given code lengths that over-subscribe the Huffman code space', () => {
    describe('When building the table', () => {
      it('Then throws DECOMPRESS_FAILED with the invalid-code-lengths reason', () => {
        // Arrange
        const sut = buildHuffmanTable;
        const overSubscribedLengths = [1, 1, 1];

        // Act & Assert
        assertDecompressFailed(() => sut(overSubscribedLengths), 'invalid huffman code lengths');
      });
    });
  });
});

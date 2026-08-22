import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ReftableCheck } from '../../../../../src/domain/refs/error.js';
import {
  blockLengthAt,
  blockTypeAt,
  parseReftable,
  readVarint,
} from '../../../../../src/domain/refs/reftable/reftable-format.js';
import { buildReftable, buildReftableBlock, buildReftableHeader } from './arbitraries.js';

// --- Poke helpers ------------------------------------------------------

function pokeMagic(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy.set([0x58, 0x58, 0x58, 0x58], 0); // 'XXXX'
  return copy;
}

function pokeVersion(bytes: Uint8Array, version: number): Uint8Array {
  const copy = bytes.slice();
  copy[4] = version;
  return copy;
}

function pokeHashId(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = bytes.slice();
  copy.set([0x78, 0x78, 0x78, 0x78], offset); // 'xxxx'
  return copy;
}

function pokeFooterCrc(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[copy.length - 1] = copy[copy.length - 1]! ^ 0xff;
  return copy;
}

function truncate(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.slice(0, length);
}

function expectRefusal(act: () => void, check: ReftableCheck, reasonContains: string): void {
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
  if (data.code !== 'INVALID_REFTABLE') {
    expect.fail(`expected INVALID_REFTABLE, got ${data.code}`);
  }
  expect(data.check).toBe(check);
  expect(data.reason).toContain(reasonContains);
}

describe('reftable-format', () => {
  describe('parseReftable', () => {
    describe('Given the measured 124-byte empty v1 table', () => {
      describe('When parsing it', () => {
        it('Then version, blockSize and both update indexes match the bytes', () => {
          // Arrange
          const bytes = buildReftable({ version: 1 });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(bytes.length).toBe(124);
          expect(result.header.version).toBe(1);
          expect(result.header.blockSize).toBe(4096);
          expect(result.header.minUpdateIndex).toBe(1n);
          expect(result.header.maxUpdateIndex).toBe(1n);
          expect(result.header.headerLength).toBe(24);
          expect(result.header.hashId).toBe('sha1');
          expect(result.header.digestLength).toBe(20);
        });
      });
    });

    describe('Given the measured 132-byte empty v2 table (SHA-256)', () => {
      describe('When parsing it', () => {
        it('Then hashId, headerLength and digestLength reflect s256', () => {
          // Arrange
          const bytes = buildReftable({ version: 2, hashId: 's256' });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(bytes.length).toBe(132);
          expect(result.header.version).toBe(2);
          expect(result.header.headerLength).toBe(28);
          expect(result.header.hashId).toBe('s256');
          expect(result.header.digestLength).toBe(32);
        });
      });
    });

    describe('Given a v2 table carrying hashId sha1', () => {
      describe('When parsing it', () => {
        it('Then version and hash are read independently — a v2 table may carry either hash', () => {
          // Arrange
          const bytes = buildReftable({ version: 2, hashId: 'sha1' });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(result.header.version).toBe(2);
          expect(result.header.hashId).toBe('sha1');
          expect(result.header.digestLength).toBe(20);
        });
      });
    });

    describe('Given a footer with all five positions non-zero', () => {
      describe('When parsing it', () => {
        it('Then every footer field, including the unpacked obj position and id length, matches the spec', () => {
          // Arrange
          const bytes = buildReftable({
            version: 1,
            refIndexPosition: 1000,
            objPosition: 2000,
            objIdLength: 5,
            objIndexPosition: 3000,
            logPosition: 4000,
            logIndexPosition: 5000,
          });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(result.footer.refIndexPosition).toBe(1000);
          expect(result.footer.objPosition).toBe(2000);
          expect(result.footer.objIdLength).toBe(5);
          expect(result.footer.objIndexPosition).toBe(3000);
          expect(result.footer.logPosition).toBe(4000);
          expect(result.footer.logIndexPosition).toBe(5000);
        });
      });
    });

    describe('Given a table with no footer positions set', () => {
      describe('When parsing it', () => {
        it("Then every footer position reads as zero — the spec's absent-section value", () => {
          // Arrange
          const bytes = buildReftable({ version: 1 });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(result.footer.refIndexPosition).toBe(0);
          expect(result.footer.objPosition).toBe(0);
          expect(result.footer.objIdLength).toBe(0);
          expect(result.footer.objIndexPosition).toBe(0);
          expect(result.footer.logPosition).toBe(0);
          expect(result.footer.logIndexPosition).toBe(0);
        });
      });
    });

    describe('Given a literally empty v1 table (header immediately followed by footer)', () => {
      describe('When parsing exactly headerLength + footerLength (92) bytes', () => {
        it('Then it parses successfully — pinning the 68-byte v1 footer length', () => {
          // Arrange
          const bytes = buildReftable({ version: 1, blocks: [] });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(bytes.length).toBe(92);
          expect(result.header.version).toBe(1);
          expect(result.footer.refIndexPosition).toBe(0);
        });
      });

      describe('When parsing one byte short of that boundary', () => {
        it('Then refuses with truncated', () => {
          // Arrange
          const bytes = truncate(buildReftable({ version: 1, blocks: [] }), 91);

          // Act & Assert
          expectRefusal(() => parseReftable(bytes), 'truncated', 'truncated');
        });
      });
    });

    describe('Given a literally empty v2 table (header immediately followed by footer)', () => {
      describe('When parsing exactly headerLength + footerLength (100) bytes', () => {
        it('Then it parses successfully — pinning the 72-byte v2 footer length', () => {
          // Arrange
          const bytes = buildReftable({ version: 2, hashId: 'sha1', blocks: [] });
          const sut = parseReftable;

          // Act
          const result = sut(bytes);

          // Assert
          expect(bytes.length).toBe(100);
          expect(result.header.version).toBe(2);
        });
      });
    });

    describe('Given a reftable with the magic bytes replaced by XXXX', () => {
      describe('When parsing', () => {
        it('Then refuses with magic', () => {
          // Arrange
          const bytes = pokeMagic(buildReftable({ version: 1 }));

          // Act & Assert
          expectRefusal(() => parseReftable(bytes), 'magic', 'magic');
        });
      });
    });

    describe('Given a reftable with version 9', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const bytes = pokeVersion(buildReftable({ version: 1 }), 9);

          // Act & Assert
          expectRefusal(() => parseReftable(bytes), 'version', 'version');
        });
      });
    });

    describe('Given a reftable truncated below the smallest possible header', () => {
      describe('When parsing', () => {
        it('Then refuses with truncated', () => {
          // Arrange
          const bytes = truncate(buildReftable({ version: 1 }), 10);

          // Act & Assert
          expectRefusal(() => parseReftable(bytes), 'truncated', 'truncated');
        });
      });
    });

    describe('Given a reftable with the footer CRC poked', () => {
      describe('When parsing', () => {
        it('Then refuses with footer-crc', () => {
          // Arrange
          const bytes = pokeFooterCrc(buildReftable({ version: 1 }));

          // Act & Assert
          expectRefusal(() => parseReftable(bytes), 'footer-crc', 'CRC');
        });
      });
    });

    describe('Given a v2 header whose hash id is neither sha1 nor s256', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const bytes = pokeHashId(buildReftable({ version: 2, hashId: 'sha1' }), 24);

          // Act & Assert
          expectRefusal(() => parseReftable(bytes), 'version', 'hash id');
        });
      });
    });
  });

  describe('readVarint', () => {
    describe.each([
      { label: '0x8011', bytes: [0x80, 0x11], value: 145 },
      { label: '0x8010', bytes: [0x80, 0x10], value: 144 },
      { label: '0x8001', bytes: [0x80, 0x01], value: 129 },
      { label: '0x9f00', bytes: [0x9f, 0x00], value: 4096 },
    ])('Given the measured multi-byte fixture $label', ({ bytes, value }) => {
      describe('When reading at offset 0', () => {
        it(`Then decodes to ${value} and advances past both bytes`, () => {
          // Arrange
          const sut = readVarint;

          // Act
          const result = sut(Uint8Array.from(bytes), 0);

          // Assert
          expect(result.value).toBe(value);
          expect(result.nextOffset).toBe(2);
        });
      });
    });

    describe('Given a single-byte value 0x05', () => {
      describe('When reading at offset 0', () => {
        it('Then decodes to 5 and advances past one byte', () => {
          // Arrange
          const sut = readVarint;

          // Act
          const result = sut(Uint8Array.from([0x05]), 0);

          // Assert
          expect(result.value).toBe(5);
          expect(result.nextOffset).toBe(1);
        });
      });
    });

    describe('Given a sequence whose continuation bit stays set for 5 bytes', () => {
      describe('When reading at offset 0', () => {
        it('Then refuses with varint-overflow', () => {
          // Arrange
          const bytes = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);

          // Act & Assert
          expectRefusal(() => readVarint(bytes, 0), 'varint-overflow', 'varint');
        });
      });
    });

    describe('Given an empty byte array', () => {
      describe('When reading at offset 0', () => {
        it('Then refuses with truncated', () => {
          // Arrange
          const bytes = new Uint8Array(0);

          // Act & Assert
          expectRefusal(() => readVarint(bytes, 0), 'truncated', 'truncated');
        });
      });
    });

    describe('Given a single continuation-marked byte with no following byte', () => {
      describe('When reading at offset 0', () => {
        it('Then refuses with truncated', () => {
          // Arrange
          const bytes = Uint8Array.from([0x80]);

          // Act & Assert
          expectRefusal(() => readVarint(bytes, 0), 'truncated', 'truncated');
        });
      });
    });

    describe('Given the 5-byte sequence 87 80 80 80 00', () => {
      describe('When reading at offset 0', () => {
        it('Then decodes to the exact positive value 2149597312, not a 32-bit-wrapped negative', () => {
          // Arrange — the security reviewer's PoC: the production decoder's
          // `((value + 1) << 7) | byte` accumulation overflows JS's 32-bit
          // signed bitwise domain partway through this exact byte sequence
          // and returns -2145369984. A downstream `prefixLength >
          // priorLength` guard silently accepts that negative as "smaller",
          // laundering attacker-controlled out-of-bounds reads as valid data.
          const bytes = Uint8Array.from([0x87, 0x80, 0x80, 0x80, 0x00]);
          const sut = readVarint;

          // Act
          const result = sut(bytes, 0);

          // Assert
          expect(result.value).toBe(2149597312);
          expect(result.value).toBeGreaterThan(0);
          expect(result.nextOffset).toBe(5);
        });
      });
    });

    describe('Given a negative read offset', () => {
      describe('When reading', () => {
        it('Then refuses with truncated rather than laundering bytes[-1] as 0', () => {
          // Arrange — `bytes[-1]` is `undefined` in JS; `undefined & 0x7f`
          // silently coerces to 0 instead of signalling an out-of-bounds
          // read, so a negative offset must be rejected explicitly.
          const bytes = Uint8Array.from([0x05]);

          // Act & Assert
          expectRefusal(() => readVarint(bytes, -1), 'truncated', 'truncated');
        });
      });
    });
  });

  describe('block framing', () => {
    describe('Given a ref block at the start of the first block', () => {
      describe('When reading blockTypeAt', () => {
        it("Then returns 'r'", () => {
          // Arrange
          const bytes = buildReftable({ version: 1 });
          const reftable = parseReftable(bytes);
          const sut = blockTypeAt;

          // Act
          const result = sut(reftable, reftable.header.headerLength);

          // Assert
          expect(result).toBe('r');
        });
      });
    });

    describe('Given a two-block v1 fixture', () => {
      describe('When reading blockLengthAt for each block', () => {
        it("Then the first block's declared length folds in the file header, and the second is its own bytes alone", () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const recordBytesA = new Uint8Array(10).fill(0xaa);
          const recordBytesB = new Uint8Array(6).fill(0xbb);
          const blockAOwnLength = 1 + 3 + recordBytesA.length + 3 + 2;
          const blockA = buildReftableBlock({
            type: 'r',
            recordBytes: recordBytesA,
            restartOffsets: [header.length + 4],
            declaredLength: header.length + blockAOwnLength,
          });
          const blockB = buildReftableBlock({
            type: 'r',
            recordBytes: recordBytesB,
            restartOffsets: [header.length + blockA.length + 4],
          });
          const bytes = buildReftable({ version: 1, blocks: [blockA, blockB] });
          const reftable = parseReftable(bytes);
          const sut = blockLengthAt;

          // Act
          const firstLength = sut(reftable, header.length);
          const secondLength = sut(reftable, header.length + blockA.length);

          // Assert
          expect(firstLength).toBe(header.length + blockA.length);
          expect(secondLength).toBe(blockB.length);
        });
      });
    });
  });
});

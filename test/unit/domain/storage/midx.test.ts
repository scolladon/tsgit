import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { MidxCheck } from '../../../../src/domain/storage/error.js';
import {
  allMidxObjectIds,
  lookupMultiPackIndex,
  parseMultiPackIndex,
} from '../../../../src/domain/storage/midx.js';
import { buildMidx, type MidxSpec } from './arbitraries.js';

// --- Fixture helpers -------------------------------------------------------

function oid(prefix: string, hexLength = 40): ObjectId {
  return (prefix + '0'.repeat(hexLength - prefix.length)) as ObjectId;
}

function baseSpec(overrides: Partial<MidxSpec> = {}): MidxSpec {
  return {
    version: 1,
    hashVersion: 1,
    digestLength: 20,
    numBaseFiles: 0,
    packNames: [
      'pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx',
      'pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.idx',
      'pack-cccccccccccccccccccccccccccccccccccccccc.idx',
    ],
    entries: [
      { id: oid('01'), packIndex: 0, offset: 100 },
      { id: oid('05'), packIndex: 1, offset: 200 },
      { id: oid('09'), packIndex: 2, offset: 300 },
    ],
    ...overrides,
  };
}

function findChunkRowIndex(bytes: Uint8Array, id: string): number {
  const numChunks = bytes[6]!;
  const decoder = new TextDecoder();
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 12 + i * 12;
    if (decoder.decode(bytes.subarray(rowStart, rowStart + 4)) === id) return i;
  }
  throw new Error(`chunk ${id} not present in fixture`);
}

function findChunkOffset(bytes: Uint8Array, id: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rowStart = 12 + findChunkRowIndex(bytes, id) * 12;
  return view.getUint32(rowStart + 4) * 0x100000000 + view.getUint32(rowStart + 8);
}

function renameChunkRow(bytes: Uint8Array, id: string, newId: string): Uint8Array {
  const copy = bytes.slice();
  const rowStart = 12 + findChunkRowIndex(copy, id) * 12;
  copy.set(new TextEncoder().encode(newId), rowStart);
  return copy;
}

// Shrinks `id`'s chunk by adjusting the offset of the row immediately after
// it in the table — that row is `id`'s end boundary, so this changes only
// `id`'s computed size without disturbing any earlier chunk's range.
function shrinkChunkAfter(bytes: Uint8Array, id: string, delta: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const nextRowStart = 12 + (findChunkRowIndex(copy, id) + 1) * 12;
  const low = view.getUint32(nextRowStart + 8);
  view.setUint32(nextRowStart + 8, low + delta);
  return copy;
}

function setChunkRowOffset(bytes: Uint8Array, rowIndex: number, offset: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const rowStart = 12 + rowIndex * 12;
  view.setUint32(rowStart + 4, Math.floor(offset / 0x100000000));
  view.setUint32(rowStart + 8, offset >>> 0);
  return copy;
}

function setSentinelId(bytes: Uint8Array, newId: string): Uint8Array {
  const copy = bytes.slice();
  const numChunks = copy[6]!;
  const rowStart = 12 + numChunks * 12;
  copy.set(new TextEncoder().encode(newId), rowStart);
  return copy;
}

function setNumChunks(bytes: Uint8Array, numChunks: number): Uint8Array {
  const copy = bytes.slice();
  copy[6] = numChunks;
  return copy;
}

function setNumPacks(bytes: Uint8Array, numPacks: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  view.setUint32(8, numPacks);
  return copy;
}

function pokeFanoutEntry(bytes: Uint8Array, index: number, value: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const oidfStart = findChunkOffset(copy, 'OIDF');
  view.setUint32(oidfStart + index * 4, value);
  return copy;
}

function setOoffOffsetWord(bytes: Uint8Array, entryIndex: number, rawWord: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const ooffStart = findChunkOffset(copy, 'OOFF');
  view.setUint32(ooffStart + entryIndex * 8 + 4, rawWord);
  return copy;
}

function setLoffHighWord(bytes: Uint8Array, row: number, highWord: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const loffStart = findChunkOffset(copy, 'LOFF');
  view.setUint32(loffStart + row * 8, highWord);
  return copy;
}

function expectRefusal(act: () => void, check: MidxCheck, reasonContains: string): void {
  try {
    act();
    expect.fail('Should have thrown');
  } catch (e) {
    const data = (e as TsgitError).data;
    if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
      expect.fail(`expected INVALID_MULTI_PACK_INDEX, got ${data.code}`);
    }
    expect(data.check).toBe(check);
    expect(data.reason).toContain(reasonContains);
  }
}

function assertExhaustiveMidxCheck(check: MidxCheck): void {
  switch (check) {
    case 'size':
    case 'signature':
    case 'version':
    case 'hash-version':
    case 'chunk-table':
    case 'required-chunk':
    case 'fanout':
    case 'chunk-length':
    case 'pack-names':
    case 'pack-int-id':
    case 'large-offset':
      return;
    default: {
      const _exhaustive: never = check;
      throw new Error(`Unhandled MidxCheck: ${String(_exhaustive)}`);
    }
  }
}

describe('midx', () => {
  describe('parseMultiPackIndex', () => {
    describe('Given a well-formed flat midx', () => {
      describe('When parsing version 1', () => {
        it('Then the parsed fields equal the spec', () => {
          // Arrange
          const spec = baseSpec({ version: 1 });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.version).toBe(1);
          expect(result.hashVersion).toBe(1);
          expect(result.digestLength).toBe(20);
          expect(result.numBaseFiles).toBe(0);
          expect(result.objectCount).toBe(3);
          expect(result.packNames).toEqual(spec.packNames);
        });
      });

      describe('When parsing version 2', () => {
        it('Then the parsed fields equal the spec', () => {
          // Arrange
          const spec = baseSpec({ version: 2 });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.version).toBe(2);
          expect(result.packNames).toEqual(spec.packNames);
        });
      });
    });

    describe('Given a midx with 0 packs and 0 objects', () => {
      describe('When parsing', () => {
        it('Then it parses with an empty pack list and object count 0', () => {
          // Arrange
          const spec = baseSpec({ packNames: [], entries: [] });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.packNames).toEqual([]);
          expect(result.objectCount).toBe(0);
        });
      });
    });

    describe('Given a midx with 1 pack', () => {
      describe('When parsing', () => {
        it('Then packNames has length 1', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 0, offset: 100 }],
          });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.packNames).toHaveLength(1);
        });
      });
    });

    describe('Given a midx with 3 packs', () => {
      describe('When parsing', () => {
        it('Then packNames has length 3', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.packNames).toHaveLength(3);
        });
      });
    });

    describe('Given a SHA-256 midx (hashVersion 2, 32-byte digest)', () => {
      describe('When parsing', () => {
        it('Then the 32-byte stride is honored end to end', () => {
          // Arrange
          const spec: MidxSpec = {
            version: 1,
            hashVersion: 2,
            digestLength: 32,
            numBaseFiles: 0,
            packNames: [`pack-${'a'.repeat(64)}.idx`],
            entries: [{ id: oid('01', 64), packIndex: 0, offset: 500 }],
          };
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, 32);

          // Assert
          expect(result.hashVersion).toBe(2);
          expect(result.digestLength).toBe(32);
          expect(lookupMultiPackIndex(result, oid('01', 64))).toEqual({
            packIndex: 0,
            offset: 500,
          });
        });
      });
    });

    describe('Given numBaseFiles=1', () => {
      describe('When parsing', () => {
        it('Then it parses and numBaseFiles is exposed unchanged', () => {
          // Arrange
          const spec = baseSpec({ numBaseFiles: 1 });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.numBaseFiles).toBe(1);
        });
      });
    });

    describe('Given numBaseFiles=2', () => {
      describe('When parsing', () => {
        it('Then it parses and numBaseFiles is exposed unchanged', () => {
          // Arrange
          const spec = baseSpec({ numBaseFiles: 2 });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.numBaseFiles).toBe(2);
        });
      });
    });

    describe('Given numBaseFiles=255', () => {
      describe('When parsing', () => {
        it('Then it parses and numBaseFiles is exposed unchanged', () => {
          // Arrange
          const spec = baseSpec({ numBaseFiles: 255 });
          const bytes = buildMidx(spec);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.numBaseFiles).toBe(255);
        });
      });
    });

    describe('Given a file shorter than the header', () => {
      describe('When parsing', () => {
        it('Then refuses with size', () => {
          // Arrange
          const bytes = new Uint8Array(11);

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, 20), 'size', 'truncated');
        });
      });
    });

    describe('Given a midx with a corrupted signature', () => {
      describe('When parsing', () => {
        it('Then refuses with signature', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes[0] = 0x00;

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'signature',
            'signature',
          );
        });
      });
    });

    describe('Given a midx with version 0', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes[4] = 0;

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, spec.digestLength), 'version', 'version');
        });
      });
    });

    describe('Given a midx with version 3', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes[4] = 3;

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, spec.digestLength), 'version', 'version');
        });
      });
    });

    describe('Given a midx with version 255', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes[4] = 255;

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, spec.digestLength), 'version', 'version');
        });
      });
    });

    describe('Given a midx with hashVersion 0', () => {
      describe('When parsing', () => {
        it('Then refuses with hash-version', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes[5] = 0;

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'hash-version',
            'hash version',
          );
        });
      });
    });

    describe('Given a midx with hashVersion 3', () => {
      describe('When parsing', () => {
        it('Then refuses with hash-version', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes[5] = 3;

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'hash-version',
            'hash version',
          );
        });
      });
    });

    describe('Given a midx whose hashVersion implies a different width than the caller declares', () => {
      describe('When parsing', () => {
        it('Then refuses with hash-version', () => {
          // Arrange
          const spec: MidxSpec = {
            version: 1,
            hashVersion: 2,
            digestLength: 32,
            numBaseFiles: 0,
            packNames: [`pack-${'a'.repeat(64)}.idx`],
            entries: [{ id: oid('01', 64), packIndex: 0, offset: 100 }],
          };
          const bytes = buildMidx(spec);

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, 20), 'hash-version', 'hash version');
        });
      });
    });

    describe('Given a file too short for its own declared chunk table', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).subarray(0, 20);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-table',
            'chunk table',
          );
        });
      });
    });

    describe('Given a chunk table offset that moves backward', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec);
          const corrupted = setChunkRowOffset(bytes, 2, findChunkOffset(bytes, 'OIDF') - 4);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'backward',
          );
        });
      });
    });

    describe('Given a chunk table offset before the table itself ends', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec);
          const corrupted = setChunkRowOffset(bytes, 0, 0);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'backward',
          );
        });
      });
    });

    describe('Given a chunk table offset past the trailer boundary', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec);
          const corrupted = setChunkRowOffset(bytes, 4, bytes.length + 10);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'end of file',
          );
        });
      });
    });

    describe('Given a chunk table whose final sentinel entry has a non-zero id', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = setSentinelId(buildMidx(spec), 'XXXX');

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-table',
            'must have id 0',
          );
        });
      });
    });

    describe('Given a midx header whose numChunks byte is 0', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table', () => {
          // Arrange — the parser only reads 1 row (the real PNAM row), whose
          // id is not the zero sentinel, so the final-entry-id rule fires
          // rather than needing a dedicated numChunks >= 1 guard.
          const spec = baseSpec();
          const bytes = setNumChunks(buildMidx(spec), 0);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-table',
            'must have id 0',
          );
        });
      });
    });

    describe('Given a midx whose PNAM chunk id is corrupted', () => {
      describe('When parsing', () => {
        it('Then refuses with required-chunk', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = renameChunkRow(buildMidx(spec), 'PNAM', 'XXXX');

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'required-chunk',
            'PNAM',
          );
        });
      });
    });

    describe('Given a midx whose OIDF chunk id is corrupted', () => {
      describe('When parsing', () => {
        it('Then refuses with required-chunk', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = renameChunkRow(buildMidx(spec), 'OIDF', 'XXXX');

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'required-chunk',
            'OIDF',
          );
        });
      });
    });

    describe('Given a midx whose OIDL chunk is absent', () => {
      describe('When parsing', () => {
        it('Then refuses with required-chunk', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = renameChunkRow(buildMidx(spec), 'OIDL', 'XXXX');

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'required-chunk',
            'OIDL',
          );
        });
      });
    });

    describe('Given a midx whose OOFF chunk is absent', () => {
      describe('When parsing', () => {
        it('Then refuses with required-chunk', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = renameChunkRow(buildMidx(spec), 'OOFF', 'XXXX');

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'required-chunk',
            'OOFF',
          );
        });
      });
    });

    describe('Given an OIDF fanout that is non-monotonic at its first comparison', () => {
      describe('When parsing', () => {
        it('Then refuses with fanout', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeFanoutEntry(buildMidx(spec), 0, 5);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'fanout',
            'non-monotonic',
          );
        });
      });
    });

    describe('Given an OIDF fanout that is non-monotonic at its last comparison', () => {
      describe('When parsing', () => {
        it('Then refuses with fanout', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = pokeFanoutEntry(buildMidx(spec), 255, 0);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'fanout',
            'non-monotonic',
          );
        });
      });
    });

    describe('Given an OIDF chunk shorter than 1024 bytes', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = shrinkChunkAfter(buildMidx(spec), 'OIDF', -4);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-length',
            'OIDF',
          );
        });
      });
    });

    describe('Given an OIDL chunk shorter than objectCount * digestLength', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = shrinkChunkAfter(buildMidx(spec), 'OIDL', -spec.digestLength);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-length',
            'OIDL',
          );
        });
      });
    });

    describe('Given an OOFF chunk shorter than objectCount * 8', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = shrinkChunkAfter(buildMidx(spec), 'OOFF', -8);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-length',
            'OOFF',
          );
        });
      });
    });

    describe('Given a LOFF chunk whose length is not a multiple of 8', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 0, offset: 0x100000000 }],
          });
          const bytes = shrinkChunkAfter(buildMidx(spec), 'LOFF', -3);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-length',
            'LOFF',
          );
        });
      });
    });

    describe('Given a PNAM chunk declaring more packs than it actually contains', () => {
      describe('When parsing', () => {
        it('Then refuses with pack-names', () => {
          // Arrange — padding is 0, so the parser runs off the end of the
          // chunk looking for a name that was never written, rather than
          // reading an empty name out of padding bytes.
          const spec = baseSpec({ packNames: ['aaa', 'bbb'], entries: [] });
          const bytes = setNumPacks(buildMidx(spec), 3);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'pack-names',
            'NUL-terminated',
          );
        });
      });
    });

    describe('Given a PNAM chunk containing more names than the header declares', () => {
      describe('When parsing', () => {
        it('Then refuses with pack-names', () => {
          // Arrange
          const spec = baseSpec({ entries: [] });
          const bytes = setNumPacks(buildMidx(spec), 2);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'pack-names',
            'padding',
          );
        });
      });
    });

    describe('Given a PNAM chunk with an empty name', () => {
      describe('When parsing', () => {
        it('Then refuses with pack-names', () => {
          // Arrange
          const spec = baseSpec({ packNames: ['', 'bbb'], entries: [] });
          const bytes = buildMidx(spec);

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, spec.digestLength), 'pack-names', 'empty');
        });
      });
    });

    describe('Given a PNAM chunk with more than 3 trailing padding bytes', () => {
      describe('When parsing', () => {
        it('Then refuses with pack-names', () => {
          // Arrange — a short second "name" so the leftover after declaring
          // only 1 pack is exactly 4 bytes: past the padding threshold but
          // not a whole realistic extra pack name.
          const spec = baseSpec({ packNames: ['aaa', 'xyz'], entries: [] });
          const bytes = setNumPacks(buildMidx(spec), 1);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'pack-names',
            'padding',
          );
        });
      });
    });

    describe('Given a version-1 midx whose PNAM chunk is not lexicographically ordered', () => {
      describe('When parsing as version 1', () => {
        it('Then refuses with pack-names', () => {
          // Arrange
          const spec = baseSpec({
            version: 1,
            packNames: [
              'pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.idx',
              'pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx',
            ],
            entries: [],
          });
          const bytes = buildMidx(spec);

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, spec.digestLength), 'pack-names', 'order');
        });
      });

      describe('When the same bytes are read as version 2', () => {
        it('Then it accepts', () => {
          // Arrange
          const spec = baseSpec({
            version: 1,
            packNames: [
              'pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.idx',
              'pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx',
            ],
            entries: [],
          });
          const bytes = buildMidx(spec).slice();
          bytes[4] = 2;

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.version).toBe(2);
          expect(result.packNames).toEqual(spec.packNames);
        });
      });
    });
  });

  describe('lookupMultiPackIndex', () => {
    describe('Given a midx with three objects across three packs', () => {
      describe('When looking up the first oid', () => {
        it('Then resolves to its packIndex and offset', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('01'));

          // Assert
          expect(result).toEqual({ packIndex: 0, offset: 100 });
        });
      });

      describe('When looking up the middle oid', () => {
        it('Then resolves to its packIndex and offset', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('05'));

          // Assert
          expect(result).toEqual({ packIndex: 1, offset: 200 });
        });
      });

      describe('When looking up the last oid', () => {
        it('Then resolves to its packIndex and offset', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('09'));

          // Assert
          expect(result).toEqual({ packIndex: 2, offset: 300 });
        });
      });

      describe('When looking up an oid below the lowest entry', () => {
        it('Then returns undefined', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('00'));

          // Assert
          expect(result).toBeUndefined();
        });
      });

      describe('When looking up an oid above the highest entry', () => {
        it('Then returns undefined', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('ff'));

          // Assert
          expect(result).toBeUndefined();
        });
      });

      describe('When looking up an oid whose fanout bucket is empty', () => {
        it('Then returns undefined', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('03'));

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given three oids sharing one fanout bucket', () => {
      describe('When looking up the smallest of them', () => {
        it('Then the binary search narrows past a greater probe and resolves it', () => {
          // Arrange — same first byte 0xaa, so the first midpoint probe
          // (aa02…) is greater than the target (aa01…), exercising the
          // upper-bound narrowing branch rather than an immediate match.
          const spec = baseSpec({
            entries: [
              { id: oid('aa01'), packIndex: 0, offset: 10 },
              { id: oid('aa02'), packIndex: 1, offset: 20 },
              { id: oid('aa03'), packIndex: 2, offset: 30 },
            ],
          });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('aa01'));

          // Assert
          expect(result).toEqual({ packIndex: 0, offset: 10 });
        });
      });

      describe('When looking up the largest of them', () => {
        it('Then the binary search narrows past a lesser probe and resolves it', () => {
          // Arrange — same first byte 0xaa, so the first midpoint probe
          // (aa02…) is less than the target (aa03…), exercising the
          // lower-bound narrowing branch rather than an immediate match.
          const spec = baseSpec({
            entries: [
              { id: oid('aa01'), packIndex: 0, offset: 10 },
              { id: oid('aa02'), packIndex: 1, offset: 20 },
              { id: oid('aa03'), packIndex: 2, offset: 30 },
            ],
          });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('aa03'));

          // Assert
          expect(result).toEqual({ packIndex: 2, offset: 30 });
        });
      });
    });

    describe('Given an entry whose packIndex exceeds the pack-name count', () => {
      describe('When looking it up', () => {
        it('Then refuses with pack-int-id', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 5, offset: 100 }],
          });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act & Assert
          expectRefusal(() => lookupMultiPackIndex(midx, oid('01')), 'pack-int-id', 'pack index');
        });
      });
    });

    describe('Given an object whose offset requires the LOFF chunk', () => {
      describe('When looking it up', () => {
        it('Then resolves the full 64-bit offset', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 0, offset: 0x100000000 }],
          });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('01'));

          // Assert
          expect(result).toEqual({ packIndex: 0, offset: 0x100000000 });
        });
      });
    });

    describe('Given a midx with both a small and a large offset (LOFF chunk present)', () => {
      describe('When looking up the small-offset entry', () => {
        it('Then resolves the offset directly without consulting LOFF', () => {
          // Arrange — proves the small-offset branch fires on its own
          // operand (bit 31 clear) even when a LOFF chunk exists elsewhere
          // in the same file.
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [
              { id: oid('01'), packIndex: 0, offset: 100 },
              { id: oid('05'), packIndex: 0, offset: 0x100000000 },
            ],
          });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('01'));

          // Assert
          expect(result).toEqual({ packIndex: 0, offset: 100 });
        });
      });
    });

    describe('Given bit 31 set on an offset word with no LOFF chunk present', () => {
      describe('When looking it up', () => {
        it('Then the word is taken literally as 0x80000000', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 0, offset: 100 }],
          });
          const bytes = setOoffOffsetWord(buildMidx(spec), 0, 0x80000000);
          const midx = parseMultiPackIndex(bytes, spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('01'));

          // Assert
          expect(result).toEqual({ packIndex: 0, offset: 0x80000000 });
        });
      });
    });

    describe('Given a large-offset row index at or past largeOffsetCount', () => {
      describe('When looking it up', () => {
        it('Then refuses with large-offset', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 0, offset: 0x100000000 }],
          });
          const bytes = setOoffOffsetWord(buildMidx(spec), 0, 0x80000000 | 5);
          const midx = parseMultiPackIndex(bytes, spec.digestLength);

          // Act & Assert
          expectRefusal(
            () => lookupMultiPackIndex(midx, oid('01')),
            'large-offset',
            'out of range',
          );
        });
      });
    });

    describe('Given a LOFF high word past the safe-integer bound', () => {
      describe('When looking it up', () => {
        it('Then refuses with large-offset', () => {
          // Arrange
          const spec = baseSpec({
            packNames: ['pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx'],
            entries: [{ id: oid('01'), packIndex: 0, offset: 0x100000000 }],
          });
          const bytes = setLoffHighWord(buildMidx(spec), 0, 0x200000);
          const midx = parseMultiPackIndex(bytes, spec.digestLength);

          // Act & Assert
          expectRefusal(() => lookupMultiPackIndex(midx, oid('01')), 'large-offset', 'safe');
        });
      });
    });
  });

  describe('allMidxObjectIds', () => {
    describe('Given a midx with 0 objects', () => {
      describe('When listing all object ids', () => {
        it('Then returns an empty array', () => {
          // Arrange
          const spec = baseSpec({ packNames: [], entries: [] });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = allMidxObjectIds(midx);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a midx with 3 objects', () => {
      describe('When listing all object ids', () => {
        it('Then returns them in sorted order', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = allMidxObjectIds(midx);

          // Assert
          expect(result).toEqual([oid('01'), oid('05'), oid('09')]);
        });
      });
    });
  });

  describe('MidxCheck exhaustiveness', () => {
    describe('Given every member of the MidxCheck union', () => {
      describe('When each is run through an exhaustive switch', () => {
        it.each<MidxCheck>([
          'size',
          'signature',
          'version',
          'hash-version',
          'chunk-table',
          'required-chunk',
          'fanout',
          'chunk-length',
          'pack-names',
          'pack-int-id',
          'large-offset',
        ])('Then %s is handled', (check) => {
          // Arrange & Act & Assert
          assertExhaustiveMidxCheck(check);
        });
      });
    });
  });
});

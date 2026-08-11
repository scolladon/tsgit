import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { MidxCheck } from '../../../../src/domain/storage/error.js';
import {
  lookupMidxPosition,
  lookupMultiPackIndex,
  midxEntryAt,
  midxOidAt,
  midxReverseIndexAt,
  midxReverseIndexPositions,
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

function appendUnknownChunk(bytes: Uint8Array, id: string, body: Uint8Array): Uint8Array {
  const digestLength = 20;
  const numChunks = bytes[6]!;
  const oldTableEnd = 12 + (numChunks + 1) * 12;
  const trailerStart = bytes.length - digestLength;
  const out = new Uint8Array(bytes.length + 12 + body.length);
  const view = new DataView(out.buffer);
  // header with one more chunk
  out.set(bytes.subarray(0, 12), 0);
  out[6] = numChunks + 1;
  // existing rows, every offset shifted by the extra table row
  const oldView = new DataView(bytes.buffer, bytes.byteOffset);
  for (let i = 0; i < numChunks; i += 1) {
    const src = 12 + i * 12;
    const dst = 12 + i * 12;
    out.set(bytes.subarray(src, src + 4), dst);
    const offset = oldView.getUint32(src + 4) * 0x100000000 + oldView.getUint32(src + 8);
    view.setUint32(dst + 4, Math.floor((offset + 12) / 0x100000000));
    view.setUint32(dst + 8, (offset + 12) >>> 0);
  }
  // the new chunk's row, where the old sentinel offset pointed
  const oldSentinel = 12 + numChunks * 12;
  const oldSentinelOffset =
    oldView.getUint32(oldSentinel + 4) * 0x100000000 + oldView.getUint32(oldSentinel + 8);
  const newChunkStart = oldSentinelOffset + 12;
  const newRow = 12 + numChunks * 12;
  out.set(new TextEncoder().encode(id), newRow);
  view.setUint32(newRow + 4, Math.floor(newChunkStart / 0x100000000));
  view.setUint32(newRow + 8, newChunkStart >>> 0);
  // new sentinel
  const sentinelRow = 12 + (numChunks + 1) * 12;
  view.setUint32(sentinelRow, 0);
  view.setUint32(sentinelRow + 4, Math.floor((newChunkStart + body.length) / 0x100000000));
  view.setUint32(sentinelRow + 8, (newChunkStart + body.length) >>> 0);
  // bodies: everything between the old table end and the trailer, then the new body, then trailer
  out.set(bytes.subarray(oldTableEnd, trailerStart), 12 + (numChunks + 2) * 12);
  out.set(body, newChunkStart);
  out.set(bytes.subarray(trailerStart), newChunkStart + body.length);
  return out;
}

function expectRefusal(act: () => void, check: MidxCheck, reasonContains: string): void {
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
  if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
    expect.fail(`expected INVALID_MULTI_PACK_INDEX, got ${data.code}`);
  }
  expect(data.check).toBe(check);
  expect(data.reason).toContain(reasonContains);
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

    describe('Given a file exactly the header size', () => {
      describe('When parsing', () => {
        it('Then it does not refuse with size — the header-length gate is exclusive', () => {
          // Arrange — a real header (valid signature/version/hashVersion/
          // numChunks) truncated right at MIDX_HEADER_SIZE: too short for
          // any chunk table row, but not for the header itself.
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice(0, 12);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-table',
            'chunk table',
          );
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

    describe('Given a mismatched signature whose value is shorter than 8 hex digits', () => {
      describe('When parsing', () => {
        it('Then the reported value is zero-padded to 8 hex digits', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec).slice();
          bytes.set([0, 0, 0, 1], 0);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'signature',
            'got 0x00000001',
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
          // Rounded to 4 so the alignment gate cannot fire before the bound gate.
          const corrupted = setChunkRowOffset(bytes, 4, Math.ceil((bytes.length + 10) / 4) * 4);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'end of file',
          );
        });
      });
    });

    describe('Given a chunk table whose end lands exactly on the trailer boundary', () => {
      describe('When parsing', () => {
        it('Then it does not refuse with chunk-table — the past-boundary gate is exclusive', () => {
          // Arrange — header (12) + one terminating sentinel row (12) + a
          // digestLength trailer: tableEnd (24) equals trailerStart (24)
          // exactly, with no room for a real chunk body. numChunks=0 still
          // fails downstream (no PNAM chunk), proving the boundary gate
          // itself let it through rather than refusing right here.
          const digestLength = 20;
          const bytes = new Uint8Array(12 + 12 + digestLength);
          const view = new DataView(bytes.buffer);
          bytes.set(new TextEncoder().encode('MIDX'), 0);
          view.setUint8(4, 1); // version
          view.setUint8(5, 1); // hashVersion
          view.setUint8(6, 0); // numChunks
          view.setUint32(12 + 4, 0); // sentinel row: offset high word
          view.setUint32(12 + 8, 24); // sentinel row: offset low word (== trailerStart)

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, digestLength), 'required-chunk', 'PNAM');
        });
      });
    });

    describe('Given a chunk table offset whose high word is non-zero', () => {
      describe('When parsing', () => {
        it('Then the 64-bit offset is reconstructed as high times 2^32 plus low, not divided by it', () => {
          // Arrange — a small low word alone would sit well inside the
          // file; only multiplying the high word out pushes this past the
          // trailer boundary.
          const spec = baseSpec();
          const bytes = buildMidx(spec);
          const corrupted = setChunkRowOffset(bytes, 4, 0x100000000 + 24);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'end of file',
          );
        });
      });
    });

    describe('Given a chunk table with a duplicate chunk id', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table naming the duplicate', () => {
          // Arrange — rewrite row 1's id word to row 0's, keeping offsets intact
          const spec = baseSpec();
          const corrupted = buildMidx(spec).slice();
          corrupted.copyWithin(12 + 12, 12, 12 + 4);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'duplicate chunk id',
          );
        });
      });
    });

    describe('Given a chunk table offset that is not 4-byte aligned', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table naming the alignment', () => {
          // Arrange — nudge row 1's offset by 2: still in bounds, still
          // never-decreasing, but off the 4-byte grid
          const spec = baseSpec();
          const bytes = buildMidx(spec);
          const view = new DataView(bytes.buffer, bytes.byteOffset);
          const row1Offset = view.getUint32(12 + 12 + 8);
          const corrupted = setChunkRowOffset(bytes, 1, row1Offset + 2);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'not 4-byte aligned',
          );
        });
      });
    });

    describe('Given an unknown trailing chunk whose length leaves the sentinel offset unaligned', () => {
      describe('When parsing', () => {
        it('Then it parses — git alignment-checks only the real chunk rows, never the sentinel', () => {
          // Arrange — synthetic-only shape: every chunk git itself writes is
          // NUL-padded to the 4-byte grid, so an unaligned sentinel can only
          // come from a foreign writer; refusing it would be a tsgit-invented
          // gate.
          const spec = baseSpec();
          const crafted = appendUnknownChunk(buildMidx(spec), 'ZZZZ', new Uint8Array(2));

          // Act
          const result = parseMultiPackIndex(crafted, spec.digestLength);

          // Assert
          expect(result.packNames).toEqual(spec.packNames);
        });
      });
    });

    describe('Given a chunk table whose terminating zero id appears before the final row', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-table naming the early terminator', () => {
          // Arrange — zero out row 0's id word; its offset stays valid
          const spec = baseSpec();
          const corrupted = buildMidx(spec).slice();
          new DataView(corrupted.buffer, corrupted.byteOffset).setUint32(12, 0);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(corrupted, spec.digestLength),
            'chunk-table',
            'before the final row',
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
          // −4 keeps every chunk offset 4-aligned (so the chunk-table gate
          // stays quiet) while leaving LOFF's length off the 8-byte stride.
          const bytes = shrinkChunkAfter(buildMidx(spec), 'LOFF', -4);

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
        it("Then reads only the declared count and leaves the remainder untouched — git enforces no cross-check between numPacks and PNAM's own span", () => {
          // Arrange
          const spec = baseSpec({ entries: [] });
          const bytes = setNumPacks(buildMidx(spec), 2);

          // Act
          const result = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(result.packNames).toEqual(spec.packNames.slice(0, 2));
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

    describe('Given a version-1 midx whose PNAM chunk repeats the same name consecutively', () => {
      describe('When parsing as version 1', () => {
        it('Then refuses with pack-names — names must be strictly increasing, not merely non-decreasing', () => {
          // Arrange
          const spec = baseSpec({
            version: 1,
            packNames: [
              'pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx',
              'pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx',
            ],
            entries: [],
          });
          const bytes = buildMidx(spec);

          // Act & Assert
          expectRefusal(() => parseMultiPackIndex(bytes, spec.digestLength), 'pack-names', 'order');
        });
      });
    });

    describe('Given a version-1 midx with three pack names, the second and third out of order', () => {
      describe('When parsing as version 1', () => {
        it('Then the reason names the exact pair of entries, not an adjacent pair past it', () => {
          // Arrange
          const spec = baseSpec({
            version: 1,
            packNames: [
              'pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx',
              'pack-cccccccccccccccccccccccccccccccccccccccc.idx',
              'pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.idx',
            ],
            entries: [],
          });
          const bytes = buildMidx(spec);

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'pack-names',
            'entries 1 and 2',
          );
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

      describe('When looking up an absent oid inside the same populated bucket', () => {
        it('Then the search narrows to exhaustion and returns undefined', () => {
          // Arrange — aa04 shares first byte 0xaa with all three entries, so
          // the window starts non-empty and the loop itself must converge on
          // the miss — unlike the below/above/empty-bucket rows, whose
          // fanout windows are empty before the first probe.
          const spec = baseSpec({
            entries: [
              { id: oid('aa01'), packIndex: 0, offset: 10 },
              { id: oid('aa02'), packIndex: 1, offset: 20 },
              { id: oid('aa03'), packIndex: 2, offset: 30 },
            ],
          });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = lookupMultiPackIndex(midx, oid('aa04'));

          // Assert
          expect(result).toBeUndefined();
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

  describe('midxOidAt', () => {
    describe('Given a midx with 0 objects', () => {
      describe('When walking positions up to objectCount', () => {
        it('Then no position exists to read', () => {
          // Arrange
          const spec = baseSpec({ packNames: [], entries: [] });
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = Array.from({ length: midx.objectCount }, (_, i) => midxOidAt(midx, i));

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a midx with 3 objects', () => {
      describe('When reading each position', () => {
        it('Then yields the oids in sorted OIDL order', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const result = Array.from({ length: midx.objectCount }, (_, i) => midxOidAt(midx, i));

          // Assert
          expect(result).toEqual([oid('01'), oid('05'), oid('09')]);
        });
      });
    });
  });

  describe('midxEntryAt', () => {
    describe('Given a midx with 3 objects across 3 packs', () => {
      describe('When reading each position directly', () => {
        it('Then each entry equals the one the binary search finds for the same oid', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act
          const direct = Array.from({ length: midx.objectCount }, (_, i) => midxEntryAt(midx, i));

          // Assert
          expect(direct).toEqual([
            lookupMultiPackIndex(midx, oid('01')),
            lookupMultiPackIndex(midx, oid('05')),
            lookupMultiPackIndex(midx, oid('09')),
          ]);
        });
      });
    });

    describe('Given an OOFF entry whose pack index is out of range', () => {
      describe('When reading that position directly', () => {
        it('Then refuses with pack-int-id, same as the searched read', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(setNumPacks(buildMidx(spec), 1), spec.digestLength);

          // Act & Assert — entry 1 routes to pack index 1, out of range for 1 name
          expectRefusal(() => midxEntryAt(midx, 1), 'pack-int-id', 'out of range');
        });
      });
    });
  });

  describe('reverse-index chunk (RIDX)', () => {
    describe('Given a midx with a reverse-index chunk', () => {
      describe('When parsing', () => {
        it('Then reverseIndexOffset is defined and midxReverseIndexAt reads position 0 and N − 1', () => {
          // Arrange
          const spec = baseSpec();
          const revBody = [2, 0, 1];
          const bytes = buildMidx({ ...spec, revBody });

          // Act
          const midx = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(midx.reverseIndexOffset).not.toBeUndefined();
          expect(midxReverseIndexAt(midx, 0)).toBe(revBody[0]);
          expect(midxReverseIndexAt(midx, midx.objectCount - 1)).toBe(revBody[revBody.length - 1]);
        });
      });
    });

    describe('Given a midx without a reverse-index chunk', () => {
      describe('When parsing', () => {
        it('Then reverseIndexOffset is undefined', () => {
          // Arrange
          const spec = baseSpec();
          const bytes = buildMidx(spec);

          // Act
          const midx = parseMultiPackIndex(bytes, spec.digestLength);

          // Assert
          expect(midx.reverseIndexOffset).toBeUndefined();
        });
      });

      describe('When calling midxReverseIndexAt', () => {
        it('Then refuses with required-chunk', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);

          // Act & Assert
          expectRefusal(() => midxReverseIndexAt(midx, 0), 'required-chunk', 'reverse-index');
        });
      });
    });

    describe('Given a RIDX chunk shorter than objectCount * 4', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange — the chunk's own declared span (via a `revBody` one
          // word short of `objectCount`) is what's wrong here; the chunk
          // table around it stays self-consistent, built by `buildMidx`
          // from the (mismatched) body length itself.
          const spec = baseSpec();
          const bytes = buildMidx({ ...spec, revBody: [0, 1] });

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-length',
            'RIDX',
          );
        });
      });
    });

    describe('Given a RIDX chunk longer than objectCount * 4', () => {
      describe('When parsing', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange — same technique as the shorter-chunk row, one word
          // over instead of under.
          const spec = baseSpec();
          const bytes = buildMidx({ ...spec, revBody: [0, 1, 2, 3] });

          // Act & Assert
          expectRefusal(
            () => parseMultiPackIndex(bytes, spec.digestLength),
            'chunk-length',
            'RIDX',
          );
        });
      });
    });

    describe('Given a midx with a reverse-index chunk', () => {
      describe('When calling midxReverseIndexAt with position === objectCount', () => {
        it('Then refuses with chunk-length', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(
            buildMidx({ ...spec, revBody: [0, 1, 2] }),
            spec.digestLength,
          );

          // Act & Assert
          expectRefusal(
            () => midxReverseIndexAt(midx, midx.objectCount),
            'chunk-length',
            'out of range',
          );
        });
      });
    });
  });

  describe('midxReverseIndexPositions', () => {
    describe('Given a midx whose reverse-index chunk stores only in-range positions', () => {
      describe('When the whole chunk is read as a table', () => {
        it('Then it reproduces every stored value, in chunk order', () => {
          // Arrange
          const spec = baseSpec();
          const revBody = [2, 0, 1];
          const midx = parseMultiPackIndex(buildMidx({ ...spec, revBody }), spec.digestLength);
          const sut = midxReverseIndexPositions;

          // Act
          const result = sut(midx);

          // Assert
          expect(result).toEqual(new Uint32Array(revBody));
        });
      });
    });

    describe('Given a midx with no reverse-index chunk at all', () => {
      describe('When the whole chunk is read as a table', () => {
        it('Then it declines with undefined rather than refusing', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);
          const sut = midxReverseIndexPositions;

          // Act
          const result = sut(midx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a midx whose reverse-index chunk stores a position it does not carry', () => {
      describe('When the whole chunk is read as a table', () => {
        it.each([
          { label: 'objectCount itself', revBody: [0, 1, 3] },
          { label: '0xffffffff', revBody: [0, 1, 0xffffffff] },
          { label: 'an out-of-range value in the FIRST slot', revBody: [7, 1, 2] },
        ])('Then $label declines the whole table', ({ revBody }) => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx({ ...spec, revBody }), spec.digestLength);
          const sut = midxReverseIndexPositions;

          // Act
          const result = sut(midx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('lookupMidxPosition', () => {
    describe('Given a midx carrying three objects', () => {
      describe('When each id is looked up by position', () => {
        it.each([
          { prefix: '01', expected: 0 },
          { prefix: '05', expected: 1 },
          { prefix: '09', expected: 2 },
        ])('Then $prefix reports midx position $expected', ({ prefix, expected }) => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);
          const sut = lookupMidxPosition;

          // Act
          const result = sut(midx, oid(prefix));

          // Assert
          expect(result).toBe(expected);
          expect(midxOidAt(midx, result as number)).toBe(oid(prefix));
        });
      });

      describe('When an id the midx does not carry is looked up', () => {
        it('Then it returns undefined', () => {
          // Arrange
          const spec = baseSpec();
          const midx = parseMultiPackIndex(buildMidx(spec), spec.digestLength);
          const sut = lookupMidxPosition;

          // Act
          const result = sut(midx, oid('0a'));

          // Assert
          expect(result).toBeUndefined();
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

import { describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../../src/adapters/memory/memory-compressor.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { ReftableCheck } from '../../../../../src/domain/refs/error.js';
import {
  blockBoundsAt,
  decodeIndexRecord,
  decodeObjRecord,
  iterateReftableRefs,
  lookupReftableRef,
  type ReftableRefRecord,
  walkBlockRecords,
} from '../../../../../src/domain/refs/reftable/reftable-block.js';
import {
  parseReftable,
  type Reftable,
  readUint24,
} from '../../../../../src/domain/refs/reftable/reftable-format.js';
import {
  iterateReftableLogs,
  LOG_BLOCK_HEADER_LENGTH,
  loadReftable,
  type ReftableLogRecord,
} from '../../../../../src/domain/refs/reftable/reftable-log.js';
import {
  buildReftableRefSection,
  canonicaliseLogMessage,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_RESTART_INTERVAL,
  type ReftableWriteOptions,
  serializeReftable,
} from '../../../../../src/domain/refs/reftable/reftable-writer.js';

// --- Fixture helpers -------------------------------------------------------

const compressor = new MemoryCompressor();
/** A pass-through "deflate" for tests that never touch the log section, or
 *  where the log section's own compressed bytes are irrelevant. */
const identityDeflate = async (data: Uint8Array): Promise<Uint8Array> => data;

function oid(fill: number, length: 20 | 32 = 20): Uint8Array {
  return new Uint8Array(length).fill(fill % 256);
}

function directRef(
  name: string,
  updateIndex: bigint,
  fill: number,
  length: 20 | 32 = 20,
): ReftableRefRecord {
  return {
    name: RefName.from(name),
    updateIndex,
    value: { kind: 'direct', id: ObjectId.fromRaw(oid(fill, length)) },
  };
}

function makeRefs(n: number): ReftableRefRecord[] {
  return Array.from({ length: n }, (_, i) =>
    directRef(`refs/heads/b${i.toString().padStart(4, '0')}`, 0n, i),
  );
}

function makeLogs(n: number): ReftableLogRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    name: RefName.from(`refs/heads/b${i.toString().padStart(4, '0')}`),
    updateIndex: BigInt(n - i),
    entry: {
      kind: 'entry' as const,
      oldId: ObjectId.fromRaw(oid(i)),
      newId: ObjectId.fromRaw(oid(i + 1)),
      identity: { name: 'A', email: 'a@b.c', timestamp: 1000, timezoneOffset: '+0000' },
      message: 'm',
    },
  }));
}

function baseOptions(overrides: Partial<ReftableWriteOptions> = {}): ReftableWriteOptions {
  return {
    hashId: 'sha1',
    blockSize: DEFAULT_BLOCK_SIZE,
    restartInterval: DEFAULT_RESTART_INTERVAL,
    indexObjects: true,
    minUpdateIndex: 0n,
    maxUpdateIndex: 1000n,
    ...overrides,
  };
}

function expectInvalidReftable(
  act: () => void,
  check: ReftableCheck,
  reasonContains: string,
): void {
  // Captured OUTSIDE the try, matching reftable-block.test.ts's own helper:
  // an expect.fail thrown inside a try would be swallowed by that same try's
  // catch and resurface as a confusing downstream TypeError instead.
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

// --- Header ------------------------------------------------------------

describe('Given a block_size too small for an index level to summarise the one below it', () => {
  describe('When serializing enough refs to force a multi-level index', () => {
    it('Then it refuses with block-bounds instead of looping forever', async () => {
      // Arrange — every index level must summarise its predecessor, so the
      // entry count has to strictly shrink. At block_size 1 a level holds one
      // record per block, so each level reproduces the previous count and the
      // multi-level loop's exit test never goes false. The refusal is what
      // stops a WRITE from hanging; no reader-side bound applies here.
      const options = baseOptions({ blockSize: 1 });
      const sut = serializeReftable;

      // Act
      const caught = await sut(makeRefs(40), [], options, identityDeflate).then(
        () => undefined,
        (err: unknown) => err,
      );

      // Assert
      expect((caught as { data: { code: string } } | undefined)?.data.code).toBe(
        'INVALID_REFTABLE',
      );
      expect((caught as { data: { check: string } }).data.check).toBe('block-bounds');
      expect((caught as { data: { reason: string } }).data.reason).toContain('did not shrink');
    }, 10_000);
  });
});

describe('Given a single ref', () => {
  describe('When building the ref section at the default block size', () => {
    it('Then the header carries the measured block_size, at v1', () => {
      // Arrange
      const options = baseOptions();

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1)], options);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      // Assert
      expect(readUint24(view, 5)).toBe(DEFAULT_BLOCK_SIZE);
    });

    it('Then the header carries the measured block_size, at v2', () => {
      // Arrange
      const options = baseOptions({ hashId: 's256' });

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1, 32)], options);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      // Assert
      expect(readUint24(view, 5)).toBe(DEFAULT_BLOCK_SIZE);
    });
  });
});

// --- Restart interval ----------------------------------------------------

describe('Given 40 refs sharing one block', () => {
  describe('When building with the measured restart interval', () => {
    it('Then a restart point lands every 16 records', async () => {
      // Arrange
      const refs = makeRefs(40);
      const bytes = await serializeReftable(refs, [], baseOptions(), identityDeflate);
      const table = parseReftable(bytes);

      // Act
      const bounds = blockBoundsAt(table, table.header.headerLength);

      // Assert
      expect(bounds.restartOffsets.length).toBe(Math.ceil(40 / DEFAULT_RESTART_INTERVAL));
    });
  });
});

// --- Padding and block_len(including header on the first block) ---------

describe('Given one ref and an aligned block size', () => {
  describe('When building the ref section', () => {
    it('Then the sole block is NOT padded — nothing downstream needs stride-based addressing to it', () => {
      // Arrange — measured against a git-made single-block reftable (a
      // two-ref fixture: 353 bytes total, no trailing zero padding),
      // diverging from the multi-block case (a git-made 3001-ref, 20-block
      // fixture: every block, including the last, padded to the
      // block_size boundary the ref index position names).
      const options = baseOptions({ blockSize: DEFAULT_BLOCK_SIZE });

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1)], options);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const declaredLength = readUint24(view, options.hashId === 'sha1' ? 24 + 1 : 28 + 1);

      // Assert
      expect(bytes.length).toBeLessThan(DEFAULT_BLOCK_SIZE);
      expect(bytes.length).toBe(declaredLength);
    });
  });

  describe('When building a ref section with more than one block', () => {
    it('Then every ref block, including the last, is padded to the block_size boundary', async () => {
      // Arrange — 21 refs at block_size 200 packs into exactly 4 ref blocks
      // (the ref-index threshold), so the ref-block run is never a sole
      // block — asserted via where the (separately, possibly sole-block)
      // ref index lands, which only sits at a block_size multiple when
      // every ref block ahead of it padded out to the boundary.
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(makeRefs(21), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.refIndexPosition % 200).toBe(0);
      expect(table.footer.refIndexPosition).toBeGreaterThan(200);
    });
  });
});

describe('Given a single ref whose record already exceeds a tiny configured block_size', () => {
  describe('When building the ref section', () => {
    it('Then the sole block is emitted as-is, with no padding added', () => {
      // Arrange — the first record in a block is always added regardless of
      // overflow (tryAddRecord only rejects a record past the first one), so
      // block_size 1 guarantees this block's own bytes already exceed it;
      // paddingLength is then <= 0 and padBlock must return bytes unpadded.
      const options = baseOptions({ blockSize: 1 });

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1)], options);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const declaredLength = readUint24(view, options.hashId === 'sha1' ? 24 + 1 : 28 + 1);

      // Assert — no padding bytes trail the declared block length, and the
      // block legitimately overran the configured (absurdly small) size.
      expect(declaredLength).toBeGreaterThan(options.blockSize);
      expect(bytes.length).toBe(declaredLength);
    });
  });
});

describe('Given the same single ref written at v1 and v2', () => {
  describe('When building an unaligned (block_size 0) ref section', () => {
    it('Then block_len grows by exactly the header-length difference', () => {
      // Arrange
      const unaligned = baseOptions({ blockSize: 0 });

      // Act
      const v1Bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1)], unaligned);
      const v2Bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1, 32)], {
        ...unaligned,
        hashId: 's256',
      });
      const v1View = new DataView(v1Bytes.buffer, v1Bytes.byteOffset, v1Bytes.byteLength);
      const v2View = new DataView(v2Bytes.buffer, v2Bytes.byteOffset, v2Bytes.byteLength);
      const v1DeclaredLength = readUint24(v1View, 24 + 1);
      const v2DeclaredLength = readUint24(v2View, 28 + 1);

      // Assert — record bytes differ only by the wider oid (32 vs 20 raw
      // bytes = 12), so subtracting that leaves exactly the 4-byte header
      // difference (v2's extra hash_id field) folded into block_len.
      expect(v2DeclaredLength - 12 - v1DeclaredLength).toBe(4);
    });
  });
});

// --- First restart offset (S2) --------------------------------------------

describe('Given an unaligned ref section', () => {
  describe('When it is written at v1', () => {
    it('Then the first restart offset is header_length + 4 (28)', () => {
      // Arrange
      const options = baseOptions({ blockSize: 0 });

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1)], options);
      const fakeTable = parseReftable(padWithFooter(bytes, 1));
      const bounds = blockBoundsAt(fakeTable, fakeTable.header.headerLength);

      // Assert
      expect(bounds.restartOffsets[0]).toBe(28);
    });
  });

  describe('When it is written at v2', () => {
    it('Then the first restart offset is header_length + 4 (32)', () => {
      // Arrange
      const options = baseOptions({ blockSize: 0, hashId: 's256' });

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1, 32)], options);
      const fakeTable = parseReftable(padWithFooter(bytes, 2));
      const bounds = blockBoundsAt(fakeTable, fakeTable.header.headerLength);

      // Assert
      expect(bounds.restartOffsets[0]).toBe(32);
    });
  });
});

/** `buildReftableRefSection` never writes a footer — glue a syntactically
 *  valid one on so `parseReftable`/`blockBoundsAt` can be reused as the
 *  restart-offset reader in tests that only care about the ref section. */
function padWithFooter(refSectionBytes: Uint8Array, version: 1 | 2): Uint8Array {
  const footerLength = version === 1 ? 68 : 72;
  const headerLength = version === 1 ? 24 : 28;
  const bytes = new Uint8Array(refSectionBytes.length + footerLength);
  bytes.set(refSectionBytes, 0);
  bytes.set(refSectionBytes.subarray(0, headerLength), refSectionBytes.length);
  const view = new DataView(bytes.buffer);
  const crcOffset = bytes.length - 4;
  view.setUint32(crcOffset, crc32For(bytes.subarray(refSectionBytes.length, crcOffset)));
  return bytes;
}

function crc32For(data: Uint8Array): number {
  // Mirrors src/domain/storage/crc32.ts's table-driven CRC-32 exactly — kept
  // local so this test file does not reach into a storage-domain internal
  // for a footer glue helper only these S2 tests need.
  const table = crc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

let cachedCrc32Table: Uint32Array | undefined;
function crc32Table(): Uint32Array {
  if (cachedCrc32Table !== undefined) {
    return cachedCrc32Table;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  cachedCrc32Table = table;
  return table;
}

// --- Threshold pairs: ref index, obj section --------------------------

describe('Given a ref set that packs into exactly 3 blocks at block_size 200', () => {
  describe('When building the ref section', () => {
    it('Then no ref index and no obj section are emitted', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(makeRefs(20), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.refIndexPosition).toBe(0);
      expect(table.footer.objPosition).toBe(0);
    });
  });
});

describe('Given a ref set that packs into exactly 4 blocks at block_size 200', () => {
  describe('When building the ref section', () => {
    it('Then a ref index and an obj section are both emitted', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(makeRefs(21), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.refIndexPosition).not.toBe(0);
      expect(table.footer.objPosition).not.toBe(0);
    });
  });

  describe('When indexObjects is false', () => {
    it('Then a ref index is still emitted but no obj section is', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 200, indexObjects: false });

      // Act
      const bytes = await serializeReftable(makeRefs(21), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.refIndexPosition).not.toBe(0);
      expect(table.footer.objPosition).toBe(0);
    });
  });
});

// --- First-block index position: git's `0`, never `header.headerLength` --

describe('Given a ref set whose ref index is emitted', () => {
  describe('When the index leaf entry naming the first ref block is decoded', () => {
    it('Then it records block_position 0, matching gits own writer convention', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(makeRefs(21), [], options, identityDeflate);
      const table = parseReftable(bytes);
      const bounds = blockBoundsAt(table, table.footer.refIndexPosition);
      const [firstEntry] = Array.from(walkBlockRecords(table._bytes, bounds, decodeIndexRecord));

      // Assert
      expect(firstEntry?.payload).toBe(0);
    });
  });

  describe('When the obj records naming objects found in the first ref block are decoded', () => {
    it('Then at least one position list carries 0, not header.headerLength', async () => {
      // Arrange — 21 distinct-object refs at block_size 200 packs the first
      // several ref records (and their obj entries) into the first ref block.
      // No obj index is emitted at this scale, so the obj section end is the
      // footer's own start — collectObjRecords assumes an obj index boundary,
      // so this walk is inlined rather than reusing it.
      const options = baseOptions({ blockSize: 200 });
      const bytes = await serializeReftable(makeRefs(21), [], options, identityDeflate);
      const table = parseReftable(bytes);
      const footerLength = options.hashId === 'sha1' ? 68 : 72;
      const boundary = table._bytes.length - footerLength;
      const positions: number[][] = [];
      let blockStart = table.footer.objPosition;

      // Act
      while (blockStart < boundary) {
        const bounds = blockBoundsAt(table, blockStart);
        for (const record of walkBlockRecords(table._bytes, bounds, decodeObjRecord)) {
          positions.push([...record.payload]);
        }
        blockStart = Math.ceil(bounds.blockEnd / options.blockSize) * options.blockSize;
      }

      // Assert
      expect(table.footer.objIndexPosition).toBe(0);
      expect(positions.some((p) => p.includes(0))).toBe(true);
    });
  });
});

// --- Threshold pair: log index ------------------------------------------

describe('Given a log set that packs into exactly 3 blocks at block_size 100', () => {
  describe('When building the log section', () => {
    it('Then no log index is emitted', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 100 });

      // Act
      const bytes = await serializeReftable([], makeLogs(6), options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.logIndexPosition).toBe(0);
    });
  });
});

describe('Given a log set that packs into exactly 4 blocks at block_size 100', () => {
  describe('When building the log section', () => {
    it('Then a log index is emitted', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 100 });

      // Act
      const bytes = await serializeReftable([], makeLogs(7), options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.logIndexPosition).not.toBe(0);
    });
  });
});

// --- obj_id_len ------------------------------------------------------------

describe('Given an obj-bearing table whose oids share a 2-byte prefix', () => {
  describe('When building the ref section', () => {
    it('Then obj_id_len is the shared prefix length plus one (3)', async () => {
      // Arrange
      const refs = makeRefs(21);
      const oidA = Uint8Array.from([0x01, 0x02, 0x03, ...new Array(17).fill(0)]);
      const oidB = Uint8Array.from([0x01, 0x02, 0x04, ...new Array(17).fill(0)]);
      const collidingHead: ReftableRefRecord[] = [
        {
          name: refs[0]?.name ?? RefName.from('refs/heads/b0000'),
          updateIndex: 0n,
          value: { kind: 'direct', id: ObjectId.fromRaw(oidA) },
        },
        {
          name: refs[1]?.name ?? RefName.from('refs/heads/b0001'),
          updateIndex: 0n,
          value: { kind: 'direct', id: ObjectId.fromRaw(oidB) },
        },
      ];
      const colliding = [...collidingHead, ...refs.slice(2)];
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(colliding, [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.objIdLength).toBe(3);
    });
  });
});

describe('Given an obj-bearing table with no adjacent oid collisions', () => {
  describe('When building the ref section', () => {
    it('Then obj_id_len falls back to the minimum of 2', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(makeRefs(21), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.objIdLength).toBe(2);
    });
  });
});

// --- Obj section shape: no object identity at all, and repeated objects ---

/** Walks every obj block between `footer.objPosition` and
 *  `footer.objIndexPosition`, decoding each record's key and position list.
 *  There is no production reader for the obj section yet (a later part), so
 *  these tests inspect the writer's own encode output directly through the
 *  exported block-decode primitives `reftable-block.test.ts` already uses
 *  for the reader side. Padding is stride-relative to `footer.objPosition`,
 *  not to file offset 0 — unlike the ref section's first block, the obj
 *  section carries no `firstBlockExtraLength` compensation, so its own
 *  start is never guaranteed block_size-aligned from 0 (measured: a ref
 *  index condensing to its own single, unpadded block shifts objPosition
 *  off any global block_size multiple). */
function collectObjRecords(
  table: Reftable,
  blockSize: number,
): ReadonlyArray<{ readonly nameBytes: Uint8Array; readonly positions: readonly number[] }> {
  const records: { nameBytes: Uint8Array; positions: readonly number[] }[] = [];
  const sectionStart = table.footer.objPosition;
  let blockStart = sectionStart;
  const footerLength = table.header.version === 1 ? 68 : 72;
  const boundary =
    table.footer.objIndexPosition !== 0
      ? table.footer.objIndexPosition
      : table._bytes.length - footerLength;
  while (blockStart < boundary) {
    const bounds = blockBoundsAt(table, blockStart);
    for (const record of walkBlockRecords(table._bytes, bounds, decodeObjRecord)) {
      records.push({ nameBytes: record.nameBytes, positions: record.payload });
    }
    const relativeEnd = bounds.blockEnd - sectionStart;
    blockStart = sectionStart + Math.ceil(relativeEnd / blockSize) * blockSize;
  }
  return records;
}

describe('Given a ref-indexed table where every ref is symbolic (no object id)', () => {
  describe('When building with indexObjects true', () => {
    it('Then the ref index is still emitted but the obj section stays empty', async () => {
      // Arrange — 30 symbolic refs clear the ref-index threshold (measured at
      // block_size 200) with no ref ever contributing an object id, so
      // collectObjEntries comes back empty despite refIndexEmitted being true.
      const refs: ReftableRefRecord[] = Array.from({ length: 30 }, (_, i) => ({
        name: RefName.from(`refs/heads/b${i.toString().padStart(4, '0')}`),
        updateIndex: 0n,
        value: { kind: 'symbolic', target: RefName.from('refs/heads/main') },
      }));
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.refIndexPosition).not.toBe(0);
      expect(table.footer.objPosition).toBe(0);
    });
  });
});

describe('Given many refs where one object is shared across more than 7 ref blocks', () => {
  describe('When building with indexObjects true', () => {
    it('Then the obj section itself gets an index, and the shared object records every distinct block position once, sorted ascending', async () => {
      // Arrange — every 6th ref (of 120, at block_size 200) points at the
      // same object; measured to land in more than 7 distinct ref blocks,
      // pushing that obj record's cnt_3 to 0 (deferring to cnt_large) and its
      // position list past a single delta, and pushing the obj section itself
      // past the 4-block index threshold.
      const popularId = ObjectId.fromRaw(new Uint8Array(20).fill(0xaa));
      const refs: ReftableRefRecord[] = Array.from({ length: 120 }, (_, i) => ({
        name: RefName.from(`refs/heads/b${i.toString().padStart(4, '0')}`),
        updateIndex: 0n,
        value:
          i % 6 === 0
            ? { kind: 'direct', id: popularId }
            : { kind: 'direct', id: ObjectId.fromRaw(oid(i + 1)) },
      }));
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);
      const objRecords = collectObjRecords(table, options.blockSize);
      const popularRecord = objRecords.find((r) => r.positions.length > 7);

      // Assert
      expect(table.footer.objIndexPosition).not.toBe(0);
      expect(popularRecord).toBeDefined();
      expect(popularRecord!.positions).toStrictEqual(
        [...popularRecord!.positions].sort((a, b) => a - b),
      );
      expect(new Set(popularRecord!.positions).size).toBe(popularRecord!.positions.length);
    });
  });
});

// --- Log message canonicalisation ---------------------------------------

describe('Given a log message with trailing newlines', () => {
  describe('When canonicalising it', () => {
    it('Then the trailing newlines are stripped and exactly one is appended', () => {
      // Arrange
      const sut = canonicaliseLogMessage;

      // Act
      const result = sut('my reason\n\n\n');

      // Assert
      expect(result).toBe('my reason\n');
    });
  });
});

describe('Given an absent (empty) log message', () => {
  describe('When canonicalising it', () => {
    it('Then it becomes a bare newline', () => {
      // Arrange
      const sut = canonicaliseLogMessage;

      // Act
      const result = sut('');

      // Assert
      expect(result).toBe('\n');
    });
  });
});

describe('Given a log message with an embedded newline', () => {
  describe('When canonicalising it', () => {
    it('Then it is refused as an invalid reftable record', () => {
      // Arrange
      const sut = canonicaliseLogMessage;

      // Act + Assert
      expectInvalidReftable(() => sut('line one\nline two'), 'record-overrun', 'embedded newline');
    });
  });
});

describe('Given a log record whose message has an embedded newline', () => {
  describe('When serializing the log section', () => {
    it('Then serializeReftable rejects it as an invalid reftable record', async () => {
      // Arrange
      const logs: ReftableLogRecord[] = [
        {
          name: RefName.from('refs/heads/main'),
          updateIndex: 0n,
          entry: {
            kind: 'entry',
            oldId: ObjectId.fromRaw(oid(1)),
            newId: ObjectId.fromRaw(oid(2)),
            identity: { name: 'A', email: 'a@b.c', timestamp: 1000, timezoneOffset: '+0000' },
            message: 'bad\nmessage',
          },
        },
      ];

      // Act + Assert
      await expect(
        serializeReftable([], logs, baseOptions(), identityDeflate),
      ).rejects.toMatchObject({
        data: { code: 'INVALID_REFTABLE', check: 'record-overrun' },
      });
    });
  });
});

describe('Given a single deletion log record for update_index 1', () => {
  describe('When the raw (un-inflated, since identityDeflate is a pass-through) key bytes are inspected directly', () => {
    it('Then the trailing 8 bytes equal 2^64 - 1 - update_index, not merely REVERSE_INT64_MAX applied twice', async () => {
      // Arrange — `REVERSE_INT64_MAX` is imported by the production writer,
      // the production reader AND the test fixture writer alike: a wrong
      // base would cancel out in any write-then-read-back assertion (both
      // sides use the same constant), shifting every key uniformly while
      // preserving relative order. The expected value below is a fresh
      // literal computed independently of that import, so a wrong constant
      // can only be caught by inspecting the on-disk bytes directly.
      const logs: ReftableLogRecord[] = [
        { name: RefName.from('HEAD'), updateIndex: 1n, entry: { kind: 'deletion' } },
      ];

      // Act — `identityDeflate` makes the log block's "compressed" bytes
      // identical to its plaintext payload, so no independent inflate step
      // is even needed to reach the raw key bytes.
      const bytes = await serializeReftable([], logs, baseOptions(), identityDeflate);
      const { footer } = parseReftable(bytes);
      const payloadStart = footer.logPosition + LOG_BLOCK_HEADER_LENGTH;
      // payload: varint(prefix_length=0) | varint(packed) | "HEAD" | NUL |
      // key-tail. Both varints are one byte: prefix_length is 0, and packed
      // = (suffix length 13 << 3) | log_type 0 = 104, well under the
      // 128 continuation threshold — so the key's 8-byte tail starts at a
      // fixed offset: 2 varint bytes, 4 name bytes, 1 NUL separator.
      const keyTailOffset = payloadStart + 2 + 4 + 1;
      const view = new DataView(bytes.buffer, bytes.byteOffset + keyTailOffset, 8);

      // Assert
      expect(view.getBigUint64(0)).toBe(0xffff_ffff_ffff_fffen);
    });
  });
});

// --- Round trip through parseReftable / loadReftable ---------------------

describe('Given a small reftable with refs and logs', () => {
  describe('When serializing then parsing at v1', () => {
    it('Then every ref and log record round-trips', async () => {
      // Arrange
      const refs = makeRefs(3);
      const logs = makeLogs(2);
      const options = baseOptions();

      // Act
      const bytes = await serializeReftable(refs, logs, options, compressor.deflate);
      const table = parseReftable(bytes);
      const loaded = await loadReftable(bytes, compressor.streamInflate);

      // Assert
      expect(table.header.version).toBe(1);
      expect(table.header.minUpdateIndex).toBe(options.minUpdateIndex);
      expect(table.header.maxUpdateIndex).toBe(options.maxUpdateIndex);
      expect([...iterateReftableRefs(table)]).toEqual(refs);
      const readLogs = [...iterateReftableLogs(loaded)];
      expect(readLogs.map((r) => r.name)).toEqual(
        [...logs].sort((a, b) => (a.name < b.name ? -1 : 1)).map((r) => r.name),
      );
    });
  });

  describe('When serializing then parsing at v2', () => {
    it('Then every ref record round-trips with 32-byte oids', async () => {
      // Arrange
      const refs = [directRef('refs/heads/main', 0n, 9, 32), directRef('refs/tags/v1', 0n, 10, 32)];
      const options = baseOptions({ hashId: 's256' });

      // Act
      const bytes = await serializeReftable(refs, [], options, compressor.deflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.header.version).toBe(2);
      expect(table.header.digestLength).toBe(32);
      for (const r of refs) {
        expect(lookupReftableRef(table, r.name)).toEqual(r);
      }
    });
  });
});

describe('Given a ref set large enough to force a multi-block index and obj section', () => {
  describe('When serializing then parsing', () => {
    it('Then every ref is still found by lookup and full iteration', async () => {
      // Arrange
      const refs = makeRefs(21);
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect([...iterateReftableRefs(table)]).toEqual(refs);
      for (const r of refs) {
        expect(lookupReftableRef(table, r.name)).toEqual(r);
      }
    });
  });
});

describe('Given a deletion ref and value kinds beyond direct', () => {
  describe('When serializing then parsing', () => {
    it('Then symbolic, peeled and deletion values all round-trip', async () => {
      // Arrange
      const refs: ReftableRefRecord[] = [
        {
          name: RefName.from('HEAD'),
          updateIndex: 0n,
          value: { kind: 'symbolic', target: RefName.from('refs/heads/main') },
        },
        {
          name: RefName.from('refs/heads/main'),
          updateIndex: 0n,
          value: { kind: 'peeled', id: ObjectId.fromRaw(oid(1)), peeled: ObjectId.fromRaw(oid(2)) },
        },
        { name: RefName.from('refs/heads/zzz'), updateIndex: 0n, value: { kind: 'deletion' } },
      ];
      const options = baseOptions();

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect([...iterateReftableRefs(table)]).toEqual(refs);
    });
  });
});

// --- writeUint24 width genericity -----------------------------------------

describe('Given a block_size whose top byte is nonzero', () => {
  describe('When building the ref section', () => {
    it('Then the header block_size round-trips through all three bytes of the uint24', () => {
      // Arrange — a value >= 0x10000 requires the top byte writeUint24 sets
      // via setUint8; a sole block is never padded, so the output stays small.
      const options = baseOptions({ blockSize: 0x10203 });

      // Act
      const bytes = buildReftableRefSection([directRef('refs/heads/main', 0n, 1)], options);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      // Assert
      expect(readUint24(view, 5)).toBe(0x10203);
    });
  });
});

// --- Restart on zero shared prefix, off the interval -----------------------

describe('Given a ref sharing no prefix at all with its predecessor, off the restart interval', () => {
  describe('When building the ref section', () => {
    it('Then it restarts anyway — the interval is not the only trigger', async () => {
      // Arrange — 'HEAD' then 'refs/heads/aaa': zero shared prefix, and
      // position 1 is not a multiple of restartInterval 16.
      const refs: ReftableRefRecord[] = [
        {
          name: RefName.from('HEAD'),
          updateIndex: 0n,
          value: { kind: 'symbolic', target: RefName.from('refs/heads/main') },
        },
        directRef('refs/heads/aaa', 0n, 1),
      ];
      const options = baseOptions({ restartInterval: 16 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);
      const bounds = blockBoundsAt(table, table.header.headerLength);

      // Assert — both records are restart points
      expect(bounds.restartOffsets.length).toBe(2);
    });
  });
});

// --- Exact-boundary overflow (STRICTLY over, not equal) --------------------

describe('Given ref records whose total (unaligned) length lands exactly at block_size', () => {
  describe('When building the ref section', () => {
    it('Then the exact-fit record stays in the same block — only a size STRICTLY over block_size overflows', () => {
      // Arrange — measure the unaligned (never-split) declared length for 5
      // refs, then use it as block_size: the last record's trial length is
      // then exactly block_size, which must still fit (only `>` splits).
      const refs = makeRefs(5);
      const restartInterval = 1000; // no interior restarts at this scale
      const unalignedOptions = baseOptions({ blockSize: 0, restartInterval });
      const exactLength = buildReftableRefSection(refs, unalignedOptions).length;
      const options = baseOptions({ blockSize: exactLength, restartInterval });

      // Act
      const bytes = buildReftableRefSection(refs, options);

      // Assert — a sole, unpadded block of exactly the measured length: no split occurred
      expect(bytes.length).toBe(exactLength);
    });
  });
});

// --- Obj/index emission at the exact threshold ------------------------------

describe('Given an obj section that packs into exactly 4 blocks at block_size 200', () => {
  describe('When building the ref section', () => {
    it('Then an obj index is still emitted — the threshold is inclusive', async () => {
      // Arrange — measured: 70 distinct-object refs at block_size 200 packs
      // the obj section into exactly 4 blocks.
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(makeRefs(70), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.objIndexPosition).not.toBe(0);
    });
  });
});

// --- Peeled refs contribute an object id ------------------------------------

describe('Given refs whose values are all peeled (not direct)', () => {
  describe('When building an obj-indexed ref section', () => {
    it('Then the peeled refs still populate the obj section', async () => {
      // Arrange — 21 peeled refs clears the ref-index threshold at block_size 200
      const refs: ReftableRefRecord[] = Array.from({ length: 21 }, (_, i) => ({
        name: RefName.from(`refs/heads/b${i.toString().padStart(4, '0')}`),
        updateIndex: 0n,
        value: {
          kind: 'peeled',
          id: ObjectId.fromRaw(oid(i)),
          peeled: ObjectId.fromRaw(oid(i + 100)),
        },
      }));
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.objPosition).not.toBe(0);
    });
  });
});

// --- Obj record order: by ascending oid, never by insertion order ----------

describe('Given refs whose objects are inserted out of oid order', () => {
  describe('When building an obj-indexed ref section', () => {
    it('Then obj records are still emitted in ascending oid order, not ref/insertion order', async () => {
      // Arrange — 'refs/heads/a1' (oid 0xff) is walked before 'refs/heads/a2'
      // (oid 0x00) since refs are name-sorted, but the obj section must be
      // oid-sorted: the smaller oid's record must come first regardless.
      const highOidRef = directRef('refs/heads/a1', 0n, 0xff);
      const lowOidRef = directRef('refs/heads/a2', 0n, 0x00);
      const filler = Array.from({ length: 19 }, (_, i) =>
        directRef(`refs/heads/f${i.toString().padStart(4, '0')}`, 0n, 50 + i),
      );
      const refs = [highOidRef, lowOidRef, ...filler];
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);
      const objRecords = collectObjRecords(table, options.blockSize);

      // Assert
      expect(objRecords[0]!.nameBytes[0]).toBe(0x00);
    });
  });
});

// --- Obj position-delta encoding: exact values, not raw/garbled ------------

describe('Given an object shared between two non-first ref blocks', () => {
  describe('When building an obj-indexed ref section', () => {
    it('Then the second position decodes exactly, not against the wrong baseline', async () => {
      // Arrange — refs at index 10 and 15 (of 21, at block_size 200) land in
      // the second and third ref blocks (measured: positions 200 and 400),
      // so `previous` is genuinely nonzero when the second delta is computed
      // — unlike an object first seen in the rewritten-to-0 first block.
      const popularId = ObjectId.fromRaw(new Uint8Array(20).fill(0xaa));
      const refs: ReftableRefRecord[] = Array.from({ length: 21 }, (_, i) => ({
        name: RefName.from(`refs/heads/b${i.toString().padStart(4, '0')}`),
        updateIndex: 0n,
        value:
          i === 10 || i === 15
            ? { kind: 'direct', id: popularId }
            : { kind: 'direct', id: ObjectId.fromRaw(oid(i + 1)) },
      }));
      const options = baseOptions({ blockSize: 200 });

      // Act
      const bytes = await serializeReftable(refs, [], options, identityDeflate);
      const table = parseReftable(bytes);
      const objRecords = collectObjRecords(table, options.blockSize);
      const popularRecord = objRecords.find((r) => r.positions.length === 2);

      // Assert
      expect(popularRecord?.positions).toStrictEqual([200, 400]);
    });
  });
});

// --- Log-index padding: an 'unaligned' block must never be padded ----------

describe('Given a log index that itself needs more than one (unaligned) block', () => {
  describe('When building the log section', () => {
    it('Then every log-index block stays unpadded, ending exactly at the footer', async () => {
      // Arrange — measured: 15 logs at block_size 100 gives a 2-block log index.
      const options = baseOptions({ blockSize: 100 });

      // Act
      const bytes = await serializeReftable([], makeLogs(15), options, identityDeflate);
      const table = parseReftable(bytes);
      const footerLength = 68;
      const footerStart = bytes.length - footerLength;
      let blockStart = table.footer.logIndexPosition;
      for (let i = 0; i < 10 && blockStart < footerStart; i += 1) {
        const bounds = blockBoundsAt(table, blockStart);
        blockStart = bounds.blockEnd;
      }

      // Assert
      expect(blockStart).toBe(footerStart);
    });
  });
});

// --- Log-block exact-boundary overflow (mirrors the ref-block case) --------

describe('Given log records whose total (unaligned) length lands exactly at the block budget', () => {
  describe('When building the log section', () => {
    it('Then the exact-fit record stays in the same block — only a size STRICTLY over budget overflows', async () => {
      // Arrange — measure the unaligned (budget = Infinity) declared length
      // for 4 restart-forced log records, then halve it into block_size so
      // budget (block_size * 2) exactly equals that measured length.
      const logs = makeLogs(4);
      const restartInterval = 1; // every record restarts, exercising restartCount arithmetic
      const measureOptions = baseOptions({ blockSize: 0, restartInterval });
      const measured = await serializeReftable([], logs, measureOptions, identityDeflate);
      const headerLength = 24;
      const footerLength = 68;
      const exactLength = measured.length - headerLength - footerLength;
      const options = baseOptions({ blockSize: exactLength / 2, restartInterval });

      // Act
      const bytes = await serializeReftable([], logs, options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert — a single log block (well under the 4-block index threshold),
      // ending exactly at the measured length: the 4th record did not overflow
      expect(table.footer.logIndexPosition).toBe(0);
      expect(bytes.length - headerLength - footerLength).toBe(exactLength);
    });
  });
});

describe('Given log records whose total (unaligned) length lands just over the block budget', () => {
  describe('When building the log section', () => {
    it('Then the last record overflows into a new block — restartCount must be counted, not miscounted', async () => {
      // Arrange — same measured length as above, minus 2: the 4th record's
      // trial length is then 2 bytes OVER budget, which must overflow. A
      // wrong restartCount (mis-added, mis-multiplied or halved instead of
      // tripled) shrinks the trial length enough to hide this overflow.
      const logs = makeLogs(4);
      const restartInterval = 1;
      const measureOptions = baseOptions({ blockSize: 0, restartInterval });
      const measured = await serializeReftable([], logs, measureOptions, identityDeflate);
      const headerLength = 24;
      const footerLength = 68;
      const exactLength = measured.length - headerLength - footerLength;
      const options = baseOptions({ blockSize: (exactLength - 2) / 2, restartInterval });

      // Act
      const bytes = await serializeReftable([], logs, options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert — two log blocks: the total now carries a second block header
      expect(table.footer.logIndexPosition).toBe(0);
      expect(bytes.length - headerLength - footerLength).toBeGreaterThan(exactLength);
    });
  });
});

// --- The first record in a (new) log block is never rejected ---------------

describe('Given a single log record whose own encoding exceeds a tiny budget', () => {
  describe('When building the log section', () => {
    it('Then it is still emitted as the sole record — the first record in a block is never rejected', async () => {
      // Arrange — block_size 1 makes budget (block_size * 2) tiny enough
      // that any real log record exceeds it.
      const options = baseOptions({ blockSize: 1 });
      const logs = makeLogs(1);

      // Act
      const bytes = await serializeReftable([], logs, options, compressor.deflate);
      const loaded = await loadReftable(bytes, compressor.streamInflate);
      const readLogs = [...iterateReftableLogs(loaded)];

      // Assert
      expect(readLogs).toHaveLength(1);
    }, 3000);
  });
});

// --- Log block type tag ------------------------------------------------------

describe('Given a log record', () => {
  describe('When building the log section', () => {
    it('Then the block type tag is the literal byte for "g"', async () => {
      // Arrange
      const options = baseOptions();

      // Act
      const bytes = await serializeReftable([], makeLogs(1), options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(bytes[table.footer.logPosition]).toBe('g'.charCodeAt(0));
    });
  });
});

// --- Unaligned (block_size 0) log budget is unbounded, not zero ------------

describe('Given several log records and an unaligned (block_size 0) budget', () => {
  describe('When building the log section', () => {
    it('Then they all pack into fewer than the index threshold — unaligned means unbounded, not zero', async () => {
      // Arrange — a zero budget would reject every record past the first in
      // each block (positionInBlock > 0 always overflows against budget 0),
      // scattering 5 logs across 5 one-record blocks and crossing the
      // 4-block index threshold; an unbounded budget keeps them in one block.
      const options = baseOptions({ blockSize: 0 });

      // Act
      const bytes = await serializeReftable([], makeLogs(5), options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.logIndexPosition).toBe(0);
    });
  });
});

// --- Log block cursor advances forward, and every entry round-trips --------

describe('Given log records that split into multiple log blocks', () => {
  describe('When building then reading back the log section', () => {
    it('Then every log entry round-trips — a backward cursor would corrupt subsequent block positions', async () => {
      // Arrange
      const options = baseOptions({ blockSize: 100 });
      const logs = makeLogs(7);

      // Act
      const bytes = await serializeReftable([], logs, options, compressor.deflate);
      const loaded = await loadReftable(bytes, compressor.streamInflate);
      const readNames = [...iterateReftableLogs(loaded)].map((r) => r.name);

      // Assert
      expect(readNames).toHaveLength(7);
    });
  });
});

describe('Given log records that trigger a log index', () => {
  describe('When building the log section', () => {
    it('Then the log index block itself ends exactly at the footer — totalLength/startPosition are exact', async () => {
      // Arrange — a wrong totalLength or startPosition places the index at
      // the wrong byte offset; footer.logIndexPosition would then either
      // fail to decode as a block or leave a gap/overlap before the footer.
      const options = baseOptions({ blockSize: 100 });
      const footerLength = 68;

      // Act
      const bytes = await serializeReftable([], makeLogs(7), options, identityDeflate);
      const table = parseReftable(bytes);
      const bounds = blockBoundsAt(table, table.footer.logIndexPosition);

      // Assert
      expect(bounds.blockEnd).toBe(bytes.length - footerLength);
    });
  });
});

// --- Empty logs: log_position stays 0 ---------------------------------------

describe('Given a ref-only table with no log records', () => {
  describe('When building the log section', () => {
    it('Then log_position stays 0, not the offset an (empty) log section would have started at', async () => {
      // Arrange
      const options = baseOptions();

      // Act
      const bytes = await serializeReftable(makeRefs(3), [], options, identityDeflate);
      const table = parseReftable(bytes);

      // Assert
      expect(table.footer.logPosition).toBe(0);
    });
  });
});

// --- Footer header-echo bytes -----------------------------------------------

describe('Given a serialized reftable', () => {
  describe('When the footer is inspected', () => {
    it('Then its leading header-echo bytes exactly match the file header', async () => {
      // Arrange
      const options = baseOptions();
      const headerLength = 24;
      const footerLength = 68;

      // Act
      const bytes = await serializeReftable(makeRefs(1), [], options, identityDeflate);
      const footerStart = bytes.length - footerLength;

      // Assert
      expect(bytes.slice(footerStart, footerStart + headerLength)).toEqual(
        bytes.slice(0, headerLength),
      );
    });
  });
});

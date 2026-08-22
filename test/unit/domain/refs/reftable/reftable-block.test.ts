import { describe, expect, it } from 'vitest';
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
  refRecordDecoder,
  walkBlockRecords,
} from '../../../../../src/domain/refs/reftable/reftable-block.js';
import { parseReftable } from '../../../../../src/domain/refs/reftable/reftable-format.js';
import {
  DEFAULT_RESTART_INTERVAL,
  type ReftableWriteOptions,
  serializeReftable,
} from '../../../../../src/domain/refs/reftable/reftable-writer.js';
import type { RefRecordSpec } from './arbitraries.js';
import {
  buildIndexBlock,
  buildObjBlock,
  buildRefBlock,
  buildReftable,
  buildReftableBlock,
  buildReftableHeader,
} from './arbitraries.js';

// --- Fixture helpers -----------------------------------------------------

function oid(fill: number): Uint8Array {
  return new Uint8Array(20).fill(fill);
}

const identityDeflate = async (data: Uint8Array): Promise<Uint8Array> => data;

/** `n` sequentially-named direct refs (`refs/heads/b0000`, `b0001`, …) — the
 *  same shape `reftable-writer.test.ts`'s own `makeRefs` uses to cross the
 *  writer's measured block-count thresholds. */
function makeSequentialRefs(n: number): ReftableRefRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    name: RefName.from(`refs/heads/b${i.toString().padStart(4, '0')}`),
    updateIndex: 0n,
    value: { kind: 'direct' as const, id: ObjectId.fromRaw(oid(i % 256)) },
  }));
}

/** `blockSize: 200` with `n` sequential refs, run through the real writer —
 *  measured at 7-13 refs for exactly 2 ref blocks and 14-20 for exactly 3,
 *  both comfortably under the 21-ref threshold where a ref index appears
 *  (`reftable-writer.test.ts`'s own 20-vs-21 threshold pair). */
async function buildNoIndexRefSection(refCount: number) {
  const options: ReftableWriteOptions = {
    hashId: 'sha1',
    blockSize: 200,
    restartInterval: DEFAULT_RESTART_INTERVAL,
    indexObjects: true,
    minUpdateIndex: 0n,
    maxUpdateIndex: 1000n,
  };
  const bytes = await serializeReftable(makeSequentialRefs(refCount), [], options, identityDeflate);
  return parseReftable(bytes);
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

/**
 * The design's measured five-ref repository, decoded byte-by-byte: `HEAD`
 * (symref), `refs/heads/{deleted,feature,main,symbolic}` and
 * `refs/tags/{lightweight,v1}` — 7 records, restarts at indices 0 and 1
 * (`HEAD` and `refs/heads/deleted`), single ref block.
 */
const REFERENCE_RECORDS: ReadonlyArray<RefRecordSpec> = [
  { name: 'HEAD', value: { kind: 'symbolic', target: 'refs/heads/main' } },
  { name: 'refs/heads/deleted', updateIndexDelta: 6, value: { kind: 'direct', id: oid(0x01) } },
  { name: 'refs/heads/feature', updateIndexDelta: 4, value: { kind: 'direct', id: oid(0x02) } },
  { name: 'refs/heads/main', updateIndexDelta: 1, value: { kind: 'direct', id: oid(0x03) } },
  {
    name: 'refs/heads/symbolic',
    updateIndexDelta: 5,
    value: { kind: 'symbolic', target: 'refs/heads/main' },
  },
  { name: 'refs/tags/lightweight', updateIndexDelta: 3, value: { kind: 'direct', id: oid(0x04) } },
  {
    name: 'refs/tags/v1',
    updateIndexDelta: 2,
    value: { kind: 'peeled', id: oid(0x05), peeled: oid(0x06) },
  },
];

function buildReferenceReftable(version: 1 | 2): Uint8Array {
  const headerSpec = version === 2 ? { version, hashId: 'sha1' as const } : { version };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: REFERENCE_RECORDS,
    restartIndices: [0, 1],
    isFirstBlock: true,
    headerLength: header.length,
  });
  return buildReftable({ ...headerSpec, blocks: [block] });
}

describe('reftable-block', () => {
  describe('iterateReftableRefs', () => {
    describe('Given the measured seven-record reference block', () => {
      describe('When iterating all records', () => {
        it('Then direct records (value_type 0x1) decode name, updateIndex and id', () => {
          // Arrange
          const reftable = parseReftable(buildReferenceReftable(1));
          const sut = iterateReftableRefs;

          // Act
          const records = Array.from(sut(reftable));
          const deleted = records.find((r) => r.name === RefName.from('refs/heads/deleted'))!;
          const main = records.find((r) => r.name === RefName.from('refs/heads/main'))!;

          // Assert
          expect(deleted.updateIndex).toBe(7n);
          expect(deleted.value).toStrictEqual({ kind: 'direct', id: ObjectId.fromRaw(oid(0x01)) });
          expect(main.updateIndex).toBe(2n);
          expect(main.value).toStrictEqual({ kind: 'direct', id: ObjectId.fromRaw(oid(0x03)) });
        });

        it('Then symbolic records (value_type 0x3) decode name, updateIndex and target', () => {
          // Arrange
          const reftable = parseReftable(buildReferenceReftable(1));
          const sut = iterateReftableRefs;

          // Act
          const records = Array.from(sut(reftable));
          const head = records.find((r) => r.name === RefName.from('HEAD'))!;
          const symbolic = records.find((r) => r.name === RefName.from('refs/heads/symbolic'))!;

          // Assert
          expect(head.updateIndex).toBe(1n);
          expect(head.value).toStrictEqual({
            kind: 'symbolic',
            target: RefName.from('refs/heads/main'),
          });
          expect(symbolic.updateIndex).toBe(6n);
          expect(symbolic.value).toStrictEqual({
            kind: 'symbolic',
            target: RefName.from('refs/heads/main'),
          });
        });

        it('Then the peeled record (value_type 0x2) decodes id and peeled', () => {
          // Arrange
          const reftable = parseReftable(buildReferenceReftable(1));
          const sut = iterateReftableRefs;

          // Act
          const records = Array.from(sut(reftable));
          const v1 = records.find((r) => r.name === RefName.from('refs/tags/v1'))!;

          // Assert
          expect(v1.updateIndex).toBe(3n);
          expect(v1.value).toStrictEqual({
            kind: 'peeled',
            id: ObjectId.fromRaw(oid(0x05)),
            peeled: ObjectId.fromRaw(oid(0x06)),
          });
        });

        it('Then records are yielded sorted by name, not creation order (deleted precedes feature)', () => {
          // Arrange
          const reftable = parseReftable(buildReferenceReftable(1));
          const sut = iterateReftableRefs;

          // Act
          const names = Array.from(sut(reftable)).map((r) => r.name);

          // Assert
          expect(names).toStrictEqual([
            'HEAD',
            'refs/heads/deleted',
            'refs/heads/feature',
            'refs/heads/main',
            'refs/heads/symbolic',
            'refs/tags/lightweight',
            'refs/tags/v1',
          ]);
        });

        it('Then HEAD is an ordinary ref record inside the stack, not a special stub', () => {
          // Arrange
          const reftable = parseReftable(buildReferenceReftable(1));
          const sut = iterateReftableRefs;

          // Act
          const head = Array.from(sut(reftable)).find((r) => r.name === RefName.from('HEAD'));

          // Assert
          expect(head?.value.kind).toBe('symbolic');
        });

        it('Then the block totals the measured 270 bytes at v1 header framing', () => {
          // Arrange
          const bytes = buildReferenceReftable(1);
          const header = buildReftableHeader({ version: 1 });
          const sut = blockBoundsAt;

          // Act
          const bounds = sut(parseReftable(bytes), header.length);

          // Assert
          expect(bounds.blockEnd).toBe(270);
        });
      });
    });

    describe('Given a block with a single deletion record', () => {
      describe('When iterating', () => {
        it('Then the deletion record (value_type 0x0) decodes with no value bytes', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const block = buildRefBlock({
            records: [{ name: 'refs/heads/gone', value: { kind: 'deletion' } }],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));
          const sut = iterateReftableRefs;

          // Act
          const [record] = Array.from(sut(reftable));

          // Assert
          expect(record!.value).toStrictEqual({ kind: 'deletion' });
        });
      });
    });

    describe('Given a restart run followed by a fresh restart boundary', () => {
      const header = buildReftableHeader({ version: 1 });
      const block = buildRefBlock({
        records: [
          { name: 'refs/heads/apple', value: { kind: 'direct', id: oid(0x11) } },
          { name: 'refs/heads/apricot', value: { kind: 'direct', id: oid(0x12) } },
          { name: 'zzz', value: { kind: 'direct', id: oid(0x13) } },
        ],
        restartIndices: [0, 2],
        isFirstBlock: true,
        headerLength: header.length,
      });
      const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));

      describe('When iterating', () => {
        it("Then a record within the first run inherits its predecessor's prefix", () => {
          // Arrange
          const sut = iterateReftableRefs;

          // Act
          const apricot = Array.from(sut(reftable)).find(
            (r) => r.name === RefName.from('refs/heads/apricot'),
          );

          // Assert
          expect(apricot).toBeDefined();
        });

        it('Then the first record of the next run does not inherit across the boundary', () => {
          // Arrange
          const sut = iterateReftableRefs;

          // Act
          const zzz = Array.from(sut(reftable)).find((r) => r.name === RefName.from('zzz'));

          // Assert
          expect(zzz).toBeDefined();
        });
      });
    });
  });

  describe('blockBoundsAt', () => {
    describe('Given the measured seven-record reference block at v1', () => {
      describe('When reading block bounds', () => {
        it('Then both restart points carry prefix_length 0', () => {
          // Arrange
          const bytes = buildReferenceReftable(1);
          const reftable = parseReftable(bytes);
          const bounds = blockBoundsAt(reftable, reftable.header.headerLength);
          const decodeRecord = refRecordDecoder(reftable.header);
          const sut = decodeRecord;

          // Act
          const first = sut(reftable._bytes, bounds.restartOffsets[0]!, undefined);
          const second = sut(reftable._bytes, bounds.restartOffsets[1]!, undefined);

          // Assert
          expect(first.payload.name).toBe(RefName.from('HEAD'));
          expect(second.payload.name).toBe(RefName.from('refs/heads/deleted'));
        });

        it('Then the first restart offset is 28 (headerLength 24 + 4)', () => {
          // Arrange
          const bytes = buildReferenceReftable(1);
          const reftable = parseReftable(bytes);
          const sut = blockBoundsAt;

          // Act
          const bounds = sut(reftable, reftable.header.headerLength);

          // Assert
          expect(bounds.restartOffsets[0]).toBe(28);
        });
      });
    });

    describe('Given the measured seven-record reference block at v2', () => {
      describe('When reading block bounds', () => {
        it('Then the first restart offset is 32 (headerLength 28 + 4)', () => {
          // Arrange
          const bytes = buildReferenceReftable(2);
          const reftable = parseReftable(bytes);
          const sut = blockBoundsAt;

          // Act
          const bounds = sut(reftable, reftable.header.headerLength);

          // Assert
          expect(bounds.restartOffsets[0]).toBe(32);
        });
      });
    });

    describe('Given a ref block whose restart_count is 0', () => {
      describe('When reading block bounds', () => {
        it('Then refuses with restart-count', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const block = buildRefBlock({
            records: [{ name: 'refs/heads/aaa', value: { kind: 'direct', id: oid(0x01) } }],
            restartIndices: [],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));

          // Act & Assert
          expectRefusal(
            () => blockBoundsAt(reftable, header.length),
            'restart-count',
            'restart_count',
          );
        });
      });
    });
  });

  describe('ref record grammar refusals', () => {
    describe('Given a ref record with reserved value_type 0x4', () => {
      describe('When iterating', () => {
        it('Then refuses with record-overrun', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const name = new TextEncoder().encode('refs/heads/x');
          const packed = (name.length << 3) | 0x4;
          const recordBytes = Uint8Array.from([0x00, packed, ...name, 0x00]);
          const block = buildReftableBlock({
            type: 'r',
            recordBytes,
            restartOffsets: [header.length + 4],
            declaredLength: header.length + 1 + 3 + recordBytes.length + 3 + 2,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));

          // Act & Assert
          expectRefusal(
            () => Array.from(iterateReftableRefs(reftable)),
            'record-overrun',
            'reserved ref value_type',
          );
        });
      });
    });

    describe('Given a record named by a restart_offset that carries a non-zero prefix', () => {
      describe('When iterating', () => {
        it('Then refuses with record-overrun', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const suffix = new TextEncoder().encode('xyz');
          const packed = (suffix.length << 3) | 0x1;
          const recordBytes = Uint8Array.from([0x05, packed, ...suffix, 0x00, ...oid(0x01)]);
          const block = buildReftableBlock({
            type: 'r',
            recordBytes,
            restartOffsets: [header.length + 4],
            declaredLength: header.length + 1 + 3 + recordBytes.length + 3 + 2,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));

          // Act & Assert
          expectRefusal(
            () => Array.from(iterateReftableRefs(reftable)),
            'record-overrun',
            'prefix_length',
          );
        });
      });
    });
  });

  describe('lookupReftableRef', () => {
    describe('Given the measured seven-record reference block', () => {
      const reftable = parseReftable(buildReferenceReftable(1));

      describe('When looking up refs/heads/main', () => {
        it('Then finds the direct record', () => {
          // Arrange
          const sut = lookupReftableRef;

          // Act
          const result = sut(reftable, RefName.from('refs/heads/main'));

          // Assert
          expect(result?.value).toStrictEqual({ kind: 'direct', id: ObjectId.fromRaw(oid(0x03)) });
        });
      });

      describe('When looking up an absent name', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = lookupReftableRef;

          // Act
          const result = sut(reftable, RefName.from('refs/heads/nope'));

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a block whose only record is a tombstone', () => {
      describe('When looking up that name', () => {
        it("Then returns the 'deletion' record faithfully", () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const block = buildRefBlock({
            records: [{ name: 'refs/heads/gone', value: { kind: 'deletion' } }],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));
          const sut = lookupReftableRef;

          // Act
          const result = sut(reftable, RefName.from('refs/heads/gone'));

          // Assert
          expect(result?.value).toStrictEqual({ kind: 'deletion' });
        });
      });
    });
  });

  describe('index records', () => {
    describe('Given the measured index head (two entries sharing a 20-byte prefix)', () => {
      describe('When walking the block', () => {
        it('Then prefix, suffix and block_position all decode correctly', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const block = buildIndexBlock({
            records: [
              { key: 'refs/heads/wide/br00154', blockPosition: 0 },
              { key: 'refs/heads/wide/br00312', blockPosition: 4096 },
            ],
            restartIndices: [0],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));
          const bounds = blockBoundsAt(reftable, header.length);
          const sut = walkBlockRecords;

          // Act
          const records = Array.from(sut(reftable._bytes, bounds, decodeIndexRecord));

          // Assert
          expect(records.map((r) => r.payload)).toStrictEqual([0, 4096]);
          expect(new TextDecoder().decode(records[1]!.nameBytes)).toBe('refs/heads/wide/br00312');
        });
      });
    });

    describe('Given a two-level ref index whose first-level entry targets another index block', () => {
      const header = buildReftableHeader({ version: 1 });
      const block0 = buildRefBlock({
        records: [{ name: 'refs/heads/aaa', value: { kind: 'direct', id: oid(0x21) } }],
        isFirstBlock: true,
        headerLength: header.length,
      });
      const pos0 = header.length;
      const block1 = buildRefBlock({
        records: [{ name: 'refs/heads/zzz', value: { kind: 'direct', id: oid(0x22) } }],
        isFirstBlock: false,
      });
      const pos1 = pos0 + block0.length;
      const leafIndex = buildIndexBlock({
        records: [
          { key: 'refs/heads/aaa', blockPosition: pos0 },
          { key: 'refs/heads/zzz', blockPosition: pos1 },
        ],
        isFirstBlock: false,
      });
      const posLeaf = pos1 + block1.length;
      const topIndex = buildIndexBlock({
        records: [{ key: 'refs/heads/zzz', blockPosition: posLeaf }],
        isFirstBlock: false,
      });
      const posTop = posLeaf + leafIndex.length;
      const reftable = parseReftable(
        buildReftable({
          version: 1,
          blocks: [block0, block1, leafIndex, topIndex],
          refIndexPosition: posTop,
        }),
      );

      describe('When looking up a name in the second ref block', () => {
        it('Then recurses through the top-level index into the leaf index to the ref block', () => {
          // Arrange
          const sut = lookupReftableRef;

          // Act
          const result = sut(reftable, RefName.from('refs/heads/zzz'));

          // Assert
          expect(result?.value).toStrictEqual({ kind: 'direct', id: ObjectId.fromRaw(oid(0x22)) });
        });
      });

      describe('When iterating every ref', () => {
        it('Then yields records from both leaf ref blocks', () => {
          // Arrange
          const sut = iterateReftableRefs;

          // Act
          const names = Array.from(sut(reftable)).map((r) => r.name);

          // Assert
          expect(names).toStrictEqual(['refs/heads/aaa', 'refs/heads/zzz']);
        });
      });
    });

    describe('Given a footer refIndexPosition pointing at a ref block instead of an index block', () => {
      describe('When looking up a name', () => {
        it('Then refuses with block-type', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const block = buildRefBlock({
            records: [{ name: 'refs/heads/aaa', value: { kind: 'direct', id: oid(0x31) } }],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(
            buildReftable({ version: 1, blocks: [block], refIndexPosition: header.length }),
          );

          // Act & Assert
          expectRefusal(
            () => lookupReftableRef(reftable, RefName.from('refs/heads/aaa')),
            'block-type',
            'expected block type',
          );
        });
      });
    });
  });

  describe('obj records', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7]) {
      describe(`Given an obj record with cnt_3 = ${count}`, () => {
        describe('When walking the block', () => {
          it('Then decodes that many positions, the first absolute and the rest relative', () => {
            // Arrange
            const positions = Array.from({ length: count }, (_, i) => (i + 1) * 4096);
            const header = buildReftableHeader({ version: 1 });
            const block = buildObjBlock({
              records: [{ key: Uint8Array.from([0xab, 0xcd]), positions }],
              isFirstBlock: true,
              headerLength: header.length,
            });
            const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));
            const bounds = blockBoundsAt(reftable, header.length);
            const sut = walkBlockRecords;

            // Act
            const [record] = Array.from(sut(reftable._bytes, bounds, decodeObjRecord));

            // Assert
            expect(record!.payload).toStrictEqual(positions);
          });
        });
      });
    }

    describe('Given an obj record with more than 7 positions (cnt_3 === 0 defers to cnt_large)', () => {
      describe('When walking the block', () => {
        it('Then decodes the full position list via the trailing cnt_large varint', () => {
          // Arrange
          const positions = [0, 4096, 8192, 12288, 16384, 20480, 24576, 28672, 32768, 36864];
          const header = buildReftableHeader({ version: 1 });
          const block = buildObjBlock({
            records: [{ key: Uint8Array.from([0x01, 0x02]), positions }],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));
          const bounds = blockBoundsAt(reftable, header.length);
          const sut = walkBlockRecords;

          // Act
          const [record] = Array.from(sut(reftable._bytes, bounds, decodeObjRecord));

          // Assert
          expect(record!.payload).toStrictEqual(positions);
        });
      });
    });

    describe('Given an obj record with cnt_3 === 0 and cnt_large === 0 (scan all refs)', () => {
      describe('When walking the block', () => {
        it('Then decodes an empty position list', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1 });
          const block = buildObjBlock({
            records: [{ key: Uint8Array.from([0xff, 0xee]), positions: [] }],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const reftable = parseReftable(buildReftable({ version: 1, blocks: [block] }));
          const bounds = blockBoundsAt(reftable, header.length);
          const sut = walkBlockRecords;

          // Act
          const [record] = Array.from(sut(reftable._bytes, bounds, decodeObjRecord));

          // Assert
          expect(record!.payload).toStrictEqual([]);
        });
      });
    });
  });

  describe('parser obligations git never emits', () => {
    describe('Given an unaligned (block_size 0) file with two ref blocks and a mandatory ref index', () => {
      describe('When iterating every ref', () => {
        it('Then walking by block_len yields every record from both blocks', () => {
          // Arrange
          const header = buildReftableHeader({ version: 1, blockSize: 0 });
          const block0 = buildRefBlock({
            records: [{ name: 'refs/heads/aaa', value: { kind: 'direct', id: oid(0x41) } }],
            isFirstBlock: true,
            headerLength: header.length,
          });
          const pos0 = header.length;
          const block1 = buildRefBlock({
            records: [{ name: 'refs/heads/bbb', value: { kind: 'direct', id: oid(0x42) } }],
            isFirstBlock: false,
          });
          const pos1 = pos0 + block0.length;
          const index = buildIndexBlock({
            records: [
              { key: 'refs/heads/aaa', blockPosition: pos0 },
              { key: 'refs/heads/bbb', blockPosition: pos1 },
            ],
            isFirstBlock: false,
          });
          const reftable = parseReftable(
            buildReftable({
              version: 1,
              blockSize: 0,
              blocks: [block0, block1, index],
              refIndexPosition: pos1 + block1.length,
            }),
          );
          const sut = iterateReftableRefs;

          // Act
          const names = Array.from(sut(reftable)).map((r) => r.name);

          // Assert
          expect(names).toStrictEqual(['refs/heads/aaa', 'refs/heads/bbb']);
        });
      });
    });

    describe('Given a log-only file (footer.logPosition set, no ref section)', () => {
      const reftable = parseReftable(buildReftable({ version: 1, blocks: [], logPosition: 500 }));

      describe('When iterating every ref', () => {
        it('Then yields nothing — dispatched by content, not by a filename extension', () => {
          // Arrange
          const sut = iterateReftableRefs;

          // Act
          const records = Array.from(sut(reftable));

          // Assert
          expect(reftable.footer.logPosition).toBe(500);
          expect(records).toStrictEqual([]);
        });
      });

      describe('When looking up any name', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = lookupReftableRef;

          // Act
          const result = sut(reftable, RefName.from('refs/heads/anything'));

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('no ref index, multi-block ref sections', () => {
    describe('Given a real-writer table packing into 2 ref blocks with no ref index', () => {
      describe('When iterating every ref', () => {
        it('Then yields every record, including those in block 2', async () => {
          // Arrange
          const table = await buildNoIndexRefSection(10);
          const sut = iterateReftableRefs;

          // Act
          const names = Array.from(sut(table)).map((r) => r.name);

          // Assert
          expect(table.footer.refIndexPosition).toBe(0);
          expect(names).toStrictEqual(makeSequentialRefs(10).map((r) => r.name));
        });
      });

      describe('When looking up a ref that lives in block 2', () => {
        it('Then finds it rather than reading as absent', async () => {
          // Arrange
          const table = await buildNoIndexRefSection(10);
          const sut = lookupReftableRef;

          // Act
          const result = sut(table, RefName.from('refs/heads/b0009'));

          // Assert
          expect(table.footer.refIndexPosition).toBe(0);
          expect(result?.value).toStrictEqual({
            kind: 'direct',
            id: ObjectId.fromRaw(oid(9)),
          });
        });
      });
    });

    describe('Given a real-writer table packing into 3 ref blocks with no ref index', () => {
      describe('When iterating every ref', () => {
        it('Then round-trips every record across all three blocks', async () => {
          // Arrange
          const table = await buildNoIndexRefSection(17);
          const sut = iterateReftableRefs;

          // Act
          const names = Array.from(sut(table)).map((r) => r.name);

          // Assert
          expect(table.footer.refIndexPosition).toBe(0);
          expect(names).toStrictEqual(makeSequentialRefs(17).map((r) => r.name));
        });
      });
    });
  });
});

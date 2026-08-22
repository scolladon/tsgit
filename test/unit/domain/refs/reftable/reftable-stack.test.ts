import { describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../../src/adapters/memory/memory-compressor.js';
import { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import { parseReftable } from '../../../../../src/domain/refs/reftable/reftable-format.js';
import type { LoadedReftable } from '../../../../../src/domain/refs/reftable/reftable-log.js';
import { loadReftable } from '../../../../../src/domain/refs/reftable/reftable-log.js';
import { createReftableStack } from '../../../../../src/domain/refs/reftable/reftable-stack.js';
import type { LogRecordSpec, RefRecordSpec } from './arbitraries.js';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
  buildReftableLogBlock,
} from './arbitraries.js';

// --- Fixture helpers -----------------------------------------------------

function oid(fill: number): Uint8Array {
  return new Uint8Array(20).fill(fill);
}

/**
 * The design's measured seven-record reference block (the same fixture
 * `reftable-block.test.ts` pins byte-for-byte), min_update_index 1 — table 1
 * of the canonical
 * two-table stack.
 */
const SEVEN_RECORDS: ReadonlyArray<RefRecordSpec> = [
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

/** Table 1 of the canonical two-table stack: `min=1, max=7`, the seven-record
 *  block above, including a *live* `refs/heads/deleted`. */
function buildTableWithLiveRecords(): LoadedReftable {
  const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 7n };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: SEVEN_RECORDS,
    restartIndices: [0, 1],
    isFirstBlock: true,
    headerLength: header.length,
  });
  const bytes = buildReftable({ ...headerSpec, blocks: [block] });
  return { ...parseReftable(bytes), logBlocks: [] };
}

/**
 * Table 2 of the canonical two-table stack: `min=8, max=8`, one tombstone
 * for `refs/heads/deleted` — the design's measured byte layout
 * `header(min=8,max=8) | 'r' 000037 | 00 8010 "refs/heads/deleted" 00 |
 * 00001c 0001 | footer` (log block omitted here; irrelevant to ref lookup).
 */
function buildTableWithTombstone(): LoadedReftable {
  const headerSpec = { version: 1 as const, minUpdateIndex: 8n, maxUpdateIndex: 8n };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: [{ name: 'refs/heads/deleted', updateIndexDelta: 0, value: { kind: 'deletion' } }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  const bytes = buildReftable({ ...headerSpec, blocks: [block] });
  return { ...parseReftable(bytes), logBlocks: [] };
}

/** A table holding a live `refs/heads/x` at the given `id` fill and
 *  `minUpdateIndex`/`maxUpdateIndex` (both equal — a single-record table). */
function buildTableWithLiveRef(name: string, idFill: number, updateIndex: bigint): LoadedReftable {
  const headerSpec = {
    version: 1 as const,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
  };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: [{ name, updateIndexDelta: 0, value: { kind: 'direct', id: oid(idFill) } }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  const bytes = buildReftable({ ...headerSpec, blocks: [block] });
  return { ...parseReftable(bytes), logBlocks: [] };
}

const compressor = new MemoryCompressor();

/** A log-only table (no ref section) holding one reflog record for `name`
 *  at `updateIndex`. */
async function buildTableWithLogRecord(
  name: string,
  updateIndex: bigint,
  message: string,
): Promise<LoadedReftable> {
  const record: LogRecordSpec = {
    refName: name,
    updateIndex,
    entry: {
      kind: 'entry',
      oldId: oid(0x00),
      newId: oid(0x01),
      name: 'Test User',
      email: 'test@example.com',
      timestamp: 1700000000,
      tzOffset: '+0000',
      message,
    },
  };
  const block = await buildReftableLogBlock({ records: [record] }, compressor.deflate);
  const header = buildReftableHeader({
    version: 1,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
  });
  const bytes = buildReftable({
    version: 1,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
    blocks: [block],
    logPosition: header.length,
  });
  return loadReftable(bytes, compressor.streamInflate);
}

/** A log-only table holding one TOMBSTONE record for `name` at `updateIndex`
 *  — the shape `applyDeleteRecords` writes for an existing live entry it
 *  shadows, never a fresh one. */
async function buildTableWithLogTombstone(
  name: string,
  updateIndex: bigint,
): Promise<LoadedReftable> {
  const record: LogRecordSpec = { refName: name, updateIndex, entry: { kind: 'deletion' } };
  const block = await buildReftableLogBlock({ records: [record] }, compressor.deflate);
  const header = buildReftableHeader({
    version: 1,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
  });
  const bytes = buildReftable({
    version: 1,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
    blocks: [block],
    logPosition: header.length,
  });
  return loadReftable(bytes, compressor.streamInflate);
}

describe('reftable-stack', () => {
  describe('Given a two-table stack whose newest table tombstones a ref', () => {
    const stack = createReftableStack([buildTableWithLiveRecords(), buildTableWithTombstone()]);

    describe('When looking the ref up', () => {
      it('Then it is absent', () => {
        // Arrange
        const sut = stack.lookup;

        // Act
        const result = sut(RefName.from('refs/heads/deleted'));

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When listing every name in the merged view', () => {
      it('Then names() omits the deleted ref and yields the other six', () => {
        // Arrange
        const sut = stack.names;

        // Act
        const result = Array.from(sut()).sort();

        // Assert
        expect(result).toStrictEqual(
          [
            'HEAD',
            'refs/heads/feature',
            'refs/heads/main',
            'refs/heads/symbolic',
            'refs/tags/lightweight',
            'refs/tags/v1',
          ].sort(),
        );
      });
    });
  });

  describe('Given a ref that only the older of two tables holds', () => {
    const older = buildTableWithLiveRef('refs/heads/only-old', 0x33, 1n);
    const newer = buildTableWithLiveRef('refs/heads/other', 0x44, 2n);
    const stack = createReftableStack([older, newer]);

    describe('When looking the ref up', () => {
      it('Then the lookup falls through the newer table to find it in the older one', () => {
        // Arrange
        const sut = stack.lookup;

        // Act
        const result = sut(RefName.from('refs/heads/only-old'));

        // Assert
        expect(result?.value).toStrictEqual({ kind: 'direct', id: ObjectId.fromRaw(oid(0x33)) });
      });
    });
  });

  describe('Given the same ref name live in two tables with different oids', () => {
    const older = buildTableWithLiveRef('refs/heads/x', 0x11, 1n);
    const newer = buildTableWithLiveRef('refs/heads/x', 0x22, 2n);
    const stack = createReftableStack([older, newer]);

    describe('When looking the ref up', () => {
      it('Then the newest table wins', () => {
        // Arrange
        const sut = stack.lookup;

        // Act
        const result = sut(RefName.from('refs/heads/x'));

        // Assert
        expect(result?.value).toStrictEqual({ kind: 'direct', id: ObjectId.fromRaw(oid(0x22)) });
      });
    });
  });

  describe('Given a ref whose reflog is split across two tables', () => {
    describe('When merging logs(name) across the stack', () => {
      it('Then records come back newest update_index first', async () => {
        // Arrange
        const older = await buildTableWithLogRecord('refs/heads/x', 2n, 'older entry');
        const newer = await buildTableWithLogRecord('refs/heads/x', 5n, 'newer entry');
        const stack = createReftableStack([older, newer]);
        const sut = stack.logs;

        // Act
        const result = Array.from(sut(RefName.from('refs/heads/x')));

        // Assert
        expect(result).toHaveLength(2);
        expect(result[0]!.updateIndex).toBe(5n);
        expect(result[1]!.updateIndex).toBe(2n);
      });
    });
  });

  describe('Given an older table’s live log entry tombstoned by a newer table at the same update_index', () => {
    describe('When merging logs(name) across the stack', () => {
      it('Then the entry is shadowed — the tombstone wins, not a concatenation of both', async () => {
        // Arrange
        const older = await buildTableWithLogRecord('refs/heads/x', 2n, 'shadowed entry');
        const newer = await buildTableWithLogTombstone('refs/heads/x', 2n);
        const stack = createReftableStack([older, newer]);
        const sut = stack.logs;

        // Act
        const result = Array.from(sut(RefName.from('refs/heads/x')));

        // Assert
        expect(result).toStrictEqual([]);
      });
    });
  });

  describe('Given a tombstoned entry at one update_index and a live entry at another, for the same name', () => {
    describe('When merging logs(name) across the stack', () => {
      it('Then only the unshadowed live entry survives', async () => {
        // Arrange
        const oldest = await buildTableWithLogRecord('refs/heads/x', 1n, 'still live');
        const older = await buildTableWithLogRecord('refs/heads/x', 2n, 'about to be shadowed');
        const newer = await buildTableWithLogTombstone('refs/heads/x', 2n);
        const stack = createReftableStack([oldest, older, newer]);
        const sut = stack.logs;

        // Act
        const result = Array.from(sut(RefName.from('refs/heads/x')));

        // Assert
        expect(result).toHaveLength(1);
        const [survivor] = result;
        expect(survivor?.updateIndex).toBe(1n);
        expect(survivor?.entry.kind).toBe('entry');
        expect(survivor?.entry.kind === 'entry' ? survivor.entry.message : undefined).toBe(
          'still live',
        );
      });
    });
  });

  describe('Given a stack of three tables', () => {
    const first = buildTableWithLiveRef('refs/heads/a', 0x01, 1n);
    const second = buildTableWithLiveRef('refs/heads/b', 0x02, 2n);
    const third = buildTableWithLiveRef('refs/heads/c', 0x03, 3n);
    const stack = createReftableStack([first, second, third]);

    describe('When reading maxUpdateIndex', () => {
      it('Then it is the newest table’s max', () => {
        // Arrange
        const sut = stack;

        // Act
        const result = sut.maxUpdateIndex;

        // Assert
        expect(result).toBe(3n);
      });
    });

    describe('When reading tables', () => {
      it('Then they are exposed oldest to newest, unchanged', () => {
        // Arrange
        const sut = stack;

        // Act
        const result = sut.tables;

        // Assert
        expect(result).toStrictEqual([first, second, third]);
      });
    });
  });

  describe('Given an empty stack', () => {
    const stack = createReftableStack([]);

    describe('When reading maxUpdateIndex', () => {
      it('Then it is 0n', () => {
        // Arrange
        const sut = stack;

        // Act
        const result = sut.maxUpdateIndex;

        // Assert
        expect(result).toBe(0n);
      });
    });

    describe('When listing names', () => {
      it('Then it yields nothing', () => {
        // Arrange
        const sut = stack.names;

        // Act
        const result = Array.from(sut());

        // Assert
        expect(result).toStrictEqual([]);
      });
    });
  });
});

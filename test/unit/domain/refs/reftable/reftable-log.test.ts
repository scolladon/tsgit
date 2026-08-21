import { describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../../src/adapters/memory/memory-compressor.js';
import { RefName } from '../../../../../src/domain/objects/index.js';
import {
  blockLengthAt,
  parseReftable,
} from '../../../../../src/domain/refs/reftable/reftable-format.js';
import {
  decodeTzOffset,
  encodeTzOffset,
  iterateReftableLogs,
  loadReftable,
  logBlockBounds,
} from '../../../../../src/domain/refs/reftable/reftable-log.js';
import type { LogRecordEntrySpec, LogRecordSpec } from './arbitraries.js';
import { buildReftable, buildReftableHeader, buildReftableLogBlock } from './arbitraries.js';

// --- Fixture helpers -----------------------------------------------------

const compressor = new MemoryCompressor();
const deflate = compressor.deflate;
const inflateAt = compressor.streamInflate;

function oid(fill: number): Uint8Array {
  return new Uint8Array(20).fill(fill);
}

function entrySpec(
  overrides: Partial<Extract<LogRecordEntrySpec, { kind: 'entry' }>> = {},
): LogRecordEntrySpec {
  return {
    kind: 'entry',
    oldId: oid(0x00),
    newId: oid(0x01),
    name: 'Test User',
    email: 'test@example.com',
    timestamp: 1700000000,
    tzOffset: '+0000',
    ...overrides,
    message: overrides.message ?? 'a reflog message',
  };
}

/** Wraps pre-built log blocks (and, optionally, trailing bytes standing in
 *  for an unparsed log index) in a full reftable file — no ref section, so
 *  `footer.logPosition` starts right after the file header. */
function buildLogOnlyReftable(
  logBlocks: ReadonlyArray<Uint8Array>,
  opts: { readonly logIndexPosition?: number; readonly trailingBytes?: Uint8Array } = {},
): Uint8Array {
  const header = buildReftableHeader({ version: 1 });
  const blocks =
    opts.trailingBytes === undefined ? [...logBlocks] : [...logBlocks, opts.trailingBytes];
  return buildReftable({
    version: 1,
    blocks,
    logPosition: header.length,
    logIndexPosition: opts.logIndexPosition ?? 0,
  });
}

/**
 * The design's measured nine-record reflog fixture: `HEAD` moves through
 * update_index 7, 6, 5, 3, 2 (descending), then `refs/heads/main` at 3, 2,
 * then `refs/heads/other` at 4, then `refs/stash` at 8 — grouped by ref name
 * in key-sorted (byte) order, newest `update_index` first within a group.
 */
const GROUPING_RECORDS: ReadonlyArray<LogRecordSpec> = [
  {
    refName: 'HEAD',
    updateIndex: 7n,
    entry: entrySpec({ message: 'checkout: moving from a to b' }),
  },
  { refName: 'HEAD', updateIndex: 6n, entry: entrySpec({ message: 'commit: six' }) },
  { refName: 'HEAD', updateIndex: 5n, entry: entrySpec({ message: 'commit: five' }) },
  { refName: 'HEAD', updateIndex: 3n, entry: entrySpec({ message: 'commit: three' }) },
  { refName: 'HEAD', updateIndex: 2n, entry: entrySpec({ message: 'commit: two' }) },
  { refName: 'refs/heads/main', updateIndex: 3n, entry: entrySpec({ message: 'commit: three' }) },
  { refName: 'refs/heads/main', updateIndex: 2n, entry: entrySpec({ message: 'commit: two' }) },
  {
    refName: 'refs/heads/other',
    updateIndex: 4n,
    entry: entrySpec({ message: 'branch: created' }),
  },
  { refName: 'refs/stash', updateIndex: 8n, entry: entrySpec({ message: 'stash: push' }) },
];

const TZ_OFFSET_ROWS: ReadonlyArray<{
  readonly label: string;
  readonly raw: number;
  readonly formatted: string;
}> = [
  { label: '+0230', raw: 230, formatted: '+0230' },
  { label: '+0100', raw: 100, formatted: '+0100' },
  { label: '-0800', raw: -800, formatted: '-0800' },
  { label: '+0000', raw: 0, formatted: '+0000' },
  { label: '-0530', raw: -530, formatted: '-0530' },
  { label: '+1345', raw: 1345, formatted: '+1345' },
];

describe('reftable-log', () => {
  describe('Given an arbitrary reflog timezone offset', () => {
    describe('When decoding the stored sint16', () => {
      it.each(TZ_OFFSET_ROWS)(
        'Then $label decodes to the raw ±HHMM string',
        ({ raw, formatted }) => {
          // Arrange
          const sut = decodeTzOffset;

          // Act
          const result = sut(raw);

          // Assert
          expect(result).toBe(formatted);
        },
      );
    });

    describe('When encoding the raw ±HHMM string', () => {
      it.each(TZ_OFFSET_ROWS)(
        'Then $label encodes back to the stored sint16',
        ({ raw, formatted }) => {
          // Arrange
          const sut = encodeTzOffset;

          // Act
          const result = sut(formatted);

          // Assert
          expect(result).toBe(raw);
        },
      );

      it.each(TZ_OFFSET_ROWS)(
        'Then $label round-trips through decodeTzOffset(encodeTzOffset(x))',
        ({ formatted }) => {
          // Arrange
          const sut = (x: string) => decodeTzOffset(encodeTzOffset(x));

          // Act
          const result = sut(formatted);

          // Assert
          expect(result).toBe(formatted);
        },
      );
    });
  });

  describe('Given a single reflog log block', () => {
    describe('When loading it via loadReftable', () => {
      it.each([
        { label: 'a nine-record block', records: GROUPING_RECORDS },
        {
          label: 'a one-record block',
          records: [{ refName: 'refs/heads/only', updateIndex: 1n, entry: entrySpec() }],
        },
      ])(
        "Then $label's declared block_len is its inflated size including the 4-byte header",
        async ({ records }) => {
          // Arrange
          const block = await buildReftableLogBlock({ records }, deflate);
          const bytes = buildLogOnlyReftable([block]);
          const declaredLength = blockLengthAt(
            parseReftable(bytes),
            buildReftableHeader({ version: 1 }).length,
          );
          const sut = loadReftable;

          // Act
          const table = await sut(bytes, inflateAt);

          // Assert
          expect(table.logBlocks).toHaveLength(1);
          expect(table.logBlocks[0]).toHaveLength(declaredLength - 4);
        },
      );

      it('Then the first restart offset is 4', async () => {
        // Arrange
        const block = await buildReftableLogBlock({ records: GROUPING_RECORDS }, deflate);
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);
        const sut = logBlockBounds;

        // Act
        const bounds = sut(table.logBlocks[0]!);

        // Assert
        expect(bounds.restartOffsets[0]).toBe(4);
      });
    });
  });

  describe('Given two consecutive unaligned log blocks', () => {
    describe('When loading them via loadReftable', () => {
      it("Then the second block is found from the first block's bytesConsumed, not block_size", async () => {
        // Arrange
        const blockA = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/a',
                updateIndex: 2n,
                entry: entrySpec({ message: 'a-second' }),
              },
              {
                refName: 'refs/heads/a',
                updateIndex: 1n,
                entry: entrySpec({ message: 'a-first' }),
              },
            ],
          },
          deflate,
        );
        const blockB = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/b',
                updateIndex: 2n,
                entry: entrySpec({ message: 'b-second' }),
              },
              {
                refName: 'refs/heads/b',
                updateIndex: 1n,
                entry: entrySpec({ message: 'b-first' }),
              },
            ],
          },
          deflate,
        );
        const bytes = buildLogOnlyReftable([blockA, blockB]);
        const sut = loadReftable;

        // Act
        const table = await sut(bytes, inflateAt);
        const records = Array.from(iterateReftableLogs(table));

        // Assert
        expect(table.logBlocks).toHaveLength(2);
        expect(
          records.map((r) => [
            r.name,
            r.updateIndex,
            r.entry.kind === 'entry' ? r.entry.message : '',
          ]),
        ).toEqual([
          ['refs/heads/a', 2n, 'a-second'],
          ['refs/heads/a', 1n, 'a-first'],
          ['refs/heads/b', 2n, 'b-second'],
          ['refs/heads/b', 1n, 'b-first'],
        ]);
      });
    });
  });

  describe('Given a log record with log_type 0 (tombstone)', () => {
    describe('When decoding it', () => {
      it('Then it decodes as a deletion with no log_data', async () => {
        // Arrange
        const block = await buildReftableLogBlock(
          {
            records: [{ refName: 'refs/heads/gone', updateIndex: 1n, entry: { kind: 'deletion' } }],
          },
          deflate,
        );
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);
        const sut = iterateReftableLogs;

        // Act
        const records = Array.from(sut(table));

        // Assert
        expect(records).toStrictEqual([
          { name: RefName.from('refs/heads/gone'), updateIndex: 1n, entry: { kind: 'deletion' } },
        ]);
      });
    });
  });

  describe('Given a log record with log_type 1 (full entry)', () => {
    describe('When decoding it', () => {
      it('Then it decodes oldId, newId, identity and message', async () => {
        // Arrange
        const entry: LogRecordEntrySpec = {
          kind: 'entry',
          oldId: oid(0x0a),
          newId: oid(0x0b),
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          timestamp: 1712345678,
          tzOffset: '-0530',
          message: 'commit: analytical engine notes',
        };
        const block = await buildReftableLogBlock(
          { records: [{ refName: 'refs/heads/main', updateIndex: 5n, entry }] },
          deflate,
        );
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);
        const sut = iterateReftableLogs;

        // Act
        const [record] = Array.from(sut(table));

        // Assert
        expect(record).toStrictEqual({
          name: RefName.from('refs/heads/main'),
          updateIndex: 5n,
          entry: {
            kind: 'entry',
            oldId: '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a',
            newId: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
            identity: {
              name: 'Ada Lovelace',
              email: 'ada@example.com',
              timestamp: 1712345678,
              timezoneOffset: '-0530',
            },
            message: 'commit: analytical engine notes',
          },
        });
      });
    });
  });

  describe('Given nine reflog records over three ref names', () => {
    describe('When iterating via iterateReftableLogs', () => {
      it('Then records decode grouped by name, newest update_index first within a group', async () => {
        // Arrange
        const block = await buildReftableLogBlock({ records: GROUPING_RECORDS }, deflate);
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);
        const sut = iterateReftableLogs;

        // Act
        const names = Array.from(sut(table)).map((r) => [r.name, r.updateIndex]);

        // Assert
        expect(names).toEqual([
          ['HEAD', 7n],
          ['HEAD', 6n],
          ['HEAD', 5n],
          ['HEAD', 3n],
          ['HEAD', 2n],
          ['refs/heads/main', 3n],
          ['refs/heads/main', 2n],
          ['refs/heads/other', 4n],
          ['refs/stash', 8n],
        ]);
      });
    });

    describe('When iterating via iterateReftableLogs filtered to HEAD', () => {
      it('Then only the HEAD group is returned, in the same order', async () => {
        // Arrange
        const block = await buildReftableLogBlock({ records: GROUPING_RECORDS }, deflate);
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);
        const sut = iterateReftableLogs;

        // Act
        const records = Array.from(sut(table, RefName.from('HEAD')));

        // Assert
        expect(records.map((r) => r.updateIndex)).toEqual([7n, 6n, 5n, 3n, 2n]);
        expect(records.every((r) => r.name === RefName.from('HEAD'))).toBe(true);
      });
    });
  });

  describe('Given the same reflog records split across a 3-block table with no log index', () => {
    describe('And the same records split across a 4-block table with a log index', () => {
      describe('When both are loaded and walked', () => {
        it('Then they yield identical records — the log index is never consulted', async () => {
          // Arrange
          const recordA: LogRecordSpec = {
            refName: 'refs/heads/a',
            updateIndex: 1n,
            entry: entrySpec({ message: 'a' }),
          };
          const recordB: LogRecordSpec = {
            refName: 'refs/heads/b',
            updateIndex: 1n,
            entry: entrySpec({ message: 'b' }),
          };
          const recordC: LogRecordSpec = {
            refName: 'refs/heads/c',
            updateIndex: 1n,
            entry: entrySpec({ message: 'c' }),
          };
          const recordD: LogRecordSpec = {
            refName: 'refs/heads/d',
            updateIndex: 1n,
            entry: entrySpec({ message: 'd' }),
          };
          const threeBlocks = [
            await buildReftableLogBlock({ records: [recordA, recordB] }, deflate),
            await buildReftableLogBlock({ records: [recordC] }, deflate),
            await buildReftableLogBlock({ records: [recordD] }, deflate),
          ];
          const fourBlocks = [
            await buildReftableLogBlock({ records: [recordA] }, deflate),
            await buildReftableLogBlock({ records: [recordB] }, deflate),
            await buildReftableLogBlock({ records: [recordC] }, deflate),
            await buildReftableLogBlock({ records: [recordD] }, deflate),
          ];
          const header = buildReftableHeader({ version: 1 });
          const fourBlocksTotalLength = fourBlocks.reduce((sum, b) => sum + b.length, 0);
          const noIndexBytes = buildLogOnlyReftable(threeBlocks);
          const withIndexBytes = buildLogOnlyReftable(fourBlocks, {
            logIndexPosition: header.length + fourBlocksTotalLength,
            trailingBytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
          });
          const sut = loadReftable;

          // Act
          const noIndexTable = await sut(noIndexBytes, inflateAt);
          const withIndexTable = await sut(withIndexBytes, inflateAt);

          // Assert
          expect(noIndexTable.footer.logIndexPosition).toBe(0);
          expect(withIndexTable.footer.logIndexPosition).not.toBe(0);
          expect(Array.from(iterateReftableLogs(noIndexTable))).toStrictEqual(
            Array.from(iterateReftableLogs(withIndexTable)),
          );
        });
      });
    });
  });
});

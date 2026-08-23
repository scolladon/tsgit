import { describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../../src/adapters/memory/memory-compressor.js';
import { RefName } from '../../../../../src/domain/objects/index.js';
import { invalidReftable } from '../../../../../src/domain/refs/error.js';
import {
  blockLengthAt,
  parseReftable,
} from '../../../../../src/domain/refs/reftable/reftable-format.js';
import {
  decodeTzOffset,
  encodeTzOffset,
  iterateReftableLogs,
  LOG_BLOCK_HEADER_LENGTH,
  LOG_TYPE_DELETION,
  LOG_TYPE_ENTRY,
  type LogInflationBudget,
  loadReftable,
  logBlockBounds,
} from '../../../../../src/domain/refs/reftable/reftable-log.js';
import { encodeOfsDistance } from '../../../../../src/domain/storage/pack-entry.js';
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

/** One `'g'`-type log block whose `block_len` (the 3 bytes right after the
 *  type byte, ALWAYS plaintext — never inside the deflate stream) can be
 *  independently lied about via `declaredLengthOverride`, isolating the
 *  size-budget guard from the record grammar: the payload itself is
 *  zero-filled and never decoded as log records by these tests. */
async function buildRawLogBlock(
  payloadLength: number,
  declaredLengthOverride?: number,
): Promise<Uint8Array> {
  const payload = new Uint8Array(payloadLength);
  const compressed = await deflate(payload);
  const bytes = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'g'.charCodeAt(0);
  const declared = declaredLengthOverride ?? LOG_BLOCK_HEADER_LENGTH + payloadLength;
  view.setUint8(1, (declared >>> 16) & 0xff);
  view.setUint16(2, declared & 0xffff);
  bytes.set(compressed, LOG_BLOCK_HEADER_LENGTH);
  return bytes;
}

/** One raw `'g'`-type log block payload holding a single tombstone record
 *  whose KEY is exactly `keyBytes` — never the 9-byte
 *  refname+separator+reverse_int64 suffix `encodeLogKey` always emits. Only
 *  reachable via a hand-crafted table: the shape `splitLogKey`'s own
 *  width guard must refuse rather than crash on. */
async function buildShortKeyLogBlock(keyBytes: Uint8Array): Promise<Uint8Array> {
  const packed = (keyBytes.length << 3) | LOG_TYPE_DELETION;
  const record = new Uint8Array([
    ...encodeOfsDistance(0),
    ...encodeOfsDistance(packed),
    ...keyBytes,
  ]);
  // One restart entry pointing at the phantom-header-relative offset 4
  // (LOG_BLOCK_HEADER_LENGTH), plus the trailing uint16 restart_count.
  const restart = new Uint8Array(5);
  const restartView = new DataView(restart.buffer);
  restartView.setUint8(0, (LOG_BLOCK_HEADER_LENGTH >>> 16) & 0xff);
  restartView.setUint16(1, LOG_BLOCK_HEADER_LENGTH & 0xffff);
  restartView.setUint16(3, 1);
  const payload = new Uint8Array([...record, ...restart]);
  const compressed = await deflate(payload);

  const bytes = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'g'.charCodeAt(0);
  const declared = LOG_BLOCK_HEADER_LENGTH + payload.length;
  view.setUint8(1, (declared >>> 16) & 0xff);
  view.setUint16(2, declared & 0xffff);
  bytes.set(compressed, LOG_BLOCK_HEADER_LENGTH);
  return bytes;
}

/** A single log-record `'r\0' + 8×0xFF` key, matched with `packed = (10 <<
 *  3) | LOG_TYPE_ENTRY` — the exact key/packed pair a real writer never
 *  produces standalone (`encodeLogKey` always pairs it with a full
 *  `log_data`), but a hostile table can. */
function entryKeyRecordPrefix(): ReadonlyArray<number> {
  const keyBytes = [0x72, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const packed = (keyBytes.length << 3) | LOG_TYPE_ENTRY;
  return [...encodeOfsDistance(0), ...encodeOfsDistance(packed), ...keyBytes];
}

/** One raw `'g'`-type log block payload holding a single ENTRY record whose
 *  `log_data` ends immediately after `time_seconds`, with no `tz_offset`
 *  bytes at all — no separate restart array is appended, so the block's
 *  trailing bytes ARE the record's own last two (`email_len` and
 *  `time_seconds`, both `0x00`), which `logBlockBounds` mis-reads as a
 *  `restart_count` of 0 and lets the walk reach this record regardless. The
 *  shape `decodeLogData`'s unguarded `getInt16` timezone read used to crash
 *  on. */
async function buildTruncatedTzLogBlock(): Promise<Uint8Array> {
  const ids = new Uint8Array(40); // old_id + new_id, all zero
  const record = new Uint8Array([
    ...entryKeyRecordPrefix(),
    ...ids,
    0x00, // name_len = 0
    0x00, // email_len = 0
    0x00, // time_seconds (single-byte varint) — the record's final byte
  ]);
  const compressed = await deflate(record);

  const bytes = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'g'.charCodeAt(0);
  const declared = LOG_BLOCK_HEADER_LENGTH + record.length;
  view.setUint8(1, (declared >>> 16) & 0xff);
  view.setUint16(2, declared & 0xffff);
  bytes.set(compressed, LOG_BLOCK_HEADER_LENGTH);
  return bytes;
}

/** One raw `'g'`-type log block payload holding a single ENTRY record whose
 *  `log_data` is truncated to 18 zero bytes — short of the 40
 *  (`old_id` + `new_id`) a real record commits to — and, again, no separate
 *  restart array. The shape `decodeLogData`'s unguarded `ObjectId.fromRaw`
 *  subarray reads used to hand off silently truncated bytes to instead of
 *  refusing at the parse boundary. */
async function buildTruncatedIdsLogBlock(): Promise<Uint8Array> {
  const shortIds = new Uint8Array(18);
  const record = new Uint8Array([...entryKeyRecordPrefix(), ...shortIds]);
  const compressed = await deflate(record);

  const bytes = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'g'.charCodeAt(0);
  const declared = LOG_BLOCK_HEADER_LENGTH + record.length;
  view.setUint8(1, (declared >>> 16) & 0xff);
  view.setUint16(2, declared & 0xffff);
  bytes.set(compressed, LOG_BLOCK_HEADER_LENGTH);
  return bytes;
}

function expectReftableRefusal(
  promise: Promise<unknown>,
  reasonContains: string,
  check?: string,
): Promise<void> {
  return promise.then(
    () => {
      expect.fail('Should have thrown');
    },
    (err: unknown) => {
      expect((err as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
      expect((err as { data: { reason: string } }).data.reason).toContain(reasonContains);
      if (check !== undefined) {
        expect((err as { data: { check: string } }).data.check).toBe(check);
      }
    },
  );
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

  describe('Given a log record whose ref name embeds a newline', () => {
    describe('When iterating', () => {
      it('Then refuses rather than yielding a name that could forge a line downstream', async () => {
        // Arrange — the reflog counterpart of `reftable-block.ts`'s ref-name
        // and symbolic-target guards: `splitLogKey` decodes the ref name
        // half of the log key the same unguarded way `refRecordDecoder` used
        // to.
        const block = await buildReftableLogBlock(
          {
            records: [
              {
                refName: 'refs/heads/evil\nfake-injected-line',
                updateIndex: 1n,
                entry: entrySpec(),
              },
            ],
          },
          deflate,
        );
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);
        const sut = iterateReftableLogs;

        // Act
        let caught: unknown;
        try {
          Array.from(sut(table));
        } catch (e) {
          caught = e;
        }

        // Assert — folds in the 'reflog ref name' subject text so a
        // StringLiteral mutant on that subject (decoupled from `data.check`)
        // still fails the assertion.
        expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
        expect((caught as { data: { reason: string } }).data.reason).toContain(
          'reflog ref name is dangerous',
        );
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

    describe('When iterating via iterateReftableLogs filtered to refs/stash (the last group in file order)', () => {
      it('Then the lazily-skipped filter matches a full decode filtered afterward, cursor-exact', async () => {
        // Arrange — reaching `refs/stash`'s single record means the reader
        // must correctly skip past every one of the 8 preceding records
        // (5 HEAD, 2 refs/heads/main, 1 refs/heads/other) via `skipLogData`
        // rather than `decodeLogData` — a one-byte drift between the two
        // would misalign the cursor and either throw or return the wrong
        // record.
        const block = await buildReftableLogBlock({ records: GROUPING_RECORDS }, deflate);
        const bytes = buildLogOnlyReftable([block]);
        const table = await loadReftable(bytes, inflateAt);

        // Act
        const filtered = Array.from(iterateReftableLogs(table, RefName.from('refs/stash')));
        const fromFull = Array.from(iterateReftableLogs(table)).filter(
          (r) => r.name === RefName.from('refs/stash'),
        );

        // Assert
        expect(filtered).toEqual(fromFull);
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.updateIndex).toBe(8n);
        expect(filtered[0]?.entry).toMatchObject({ kind: 'entry', message: 'stash: push' });
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

  describe('log-block inflation budget', () => {
    describe('Given a log block declaring far more inflated bytes than the per-block budget', () => {
      describe('When loading the table', () => {
        it('Then refuses with block-bounds before ever inflating it', async () => {
          // Arrange — the declared length alone (plaintext, read before any
          // inflate call) already exceeds the budget, so this needs no large
          // payload: a decompression bomb is refused on its own advertised
          // size, not only once it has already expanded.
          const block = await buildRawLogBlock(10, LOG_BLOCK_HEADER_LENGTH + 10_000_000);
          const bytes = buildLogOnlyReftable([block]);
          const budget: LogInflationBudget = { maxBlockBytes: 1000, maxTableBytes: 1_000_000 };
          const sut = loadReftable;

          // Act & Assert
          await expectReftableRefusal(sut(bytes, inflateAt, budget), 'per-block limit');
        });
      });
    });

    describe('Given a log block declaring more inflated bytes than the DEFAULT per-block budget', () => {
      describe('When loading the table without an explicit budget', () => {
        it('Then refuses with block-bounds before ever inflating it', async () => {
          // Arrange — proves the default budget's own per-block guard is
          // reachable in production, not dead code: the declared size here
          // (10,000,000) sits below the block header's own uint24 ceiling
          // (~16.7 MiB) but above DEFAULT_LOG_INFLATION_BUDGET's own
          // maxBlockBytes, so the DEFAULT budget — not an overridden one —
          // is what must reject it.
          const block = await buildRawLogBlock(10, LOG_BLOCK_HEADER_LENGTH + 10_000_000);
          const bytes = buildLogOnlyReftable([block]);
          const sut = loadReftable;

          // Act & Assert
          await expectReftableRefusal(sut(bytes, inflateAt), 'per-block limit');
        });
      });
    });

    describe('Given a log block whose actual inflated size disagrees with its declared block_len', () => {
      describe('When loading the table', () => {
        it('Then refuses with block-bounds naming the mismatch', async () => {
          // Arrange — the payload really is 50 bytes and inflates cleanly;
          // only the plaintext length field lies.
          const block = await buildRawLogBlock(50, LOG_BLOCK_HEADER_LENGTH + 57);
          const bytes = buildLogOnlyReftable([block]);
          const budget: LogInflationBudget = { maxBlockBytes: 1000, maxTableBytes: 1_000_000 };
          const sut = loadReftable;

          // Act & Assert
          await expectReftableRefusal(sut(bytes, inflateAt, budget), 'not its declared');
        });
      });
    });

    describe('Given correctly-declared log blocks whose combined size exceeds the per-table budget', () => {
      describe('When loading the table', () => {
        it('Then refuses with block-bounds naming the aggregate limit', async () => {
          // Arrange — each block is individually honest and well under the
          // per-block budget; only their sum crosses the per-table one.
          const blocks = [
            await buildRawLogBlock(150),
            await buildRawLogBlock(150),
            await buildRawLogBlock(150),
          ];
          const bytes = buildLogOnlyReftable(blocks);
          const budget: LogInflationBudget = { maxBlockBytes: 1000, maxTableBytes: 300 };
          const sut = loadReftable;

          // Act & Assert
          await expectReftableRefusal(sut(bytes, inflateAt, budget), 'aggregate limit');
        });
      });
    });

    describe('Given log blocks well within both budgets', () => {
      describe('When loading the table', () => {
        it('Then loads normally — regression guard against over-refusing', async () => {
          // Arrange
          const block = await buildRawLogBlock(50);
          const bytes = buildLogOnlyReftable([block]);
          const budget: LogInflationBudget = { maxBlockBytes: 1000, maxTableBytes: 1000 };
          const sut = loadReftable;

          // Act
          const table = await sut(bytes, inflateAt, budget);

          // Assert
          expect(table.logBlocks).toHaveLength(1);
          expect(table.logBlocks[0]).toHaveLength(50);
        });
      });
    });

    describe('Given a log block declaring block_len shorter than its own 4-byte header', () => {
      describe('When loading the table', () => {
        it('Then refuses with block-bounds instead of an unclassified decompress failure', async () => {
          // Arrange — block_len 0 makes declaredPayloadBytes negative
          // (0 - LOG_BLOCK_HEADER_LENGTH), which used to slip past the
          // `> maxBlockBytes` check (a negative number is never greater
          // than a positive budget) and reach `inflateAt` with a negative
          // output bound instead.
          const block = await buildRawLogBlock(0, 0);
          const bytes = buildLogOnlyReftable([block]);
          const sut = loadReftable;

          // Act & Assert — 'declares block_len 0' pins the message's own
          // `declaredPayloadBytes + LOG_BLOCK_HEADER_LENGTH` arithmetic
          // (0 + 4 - 4 = 0), not just the surrounding prose.
          await expectReftableRefusal(sut(bytes, inflateAt), 'declares block_len 0, shorter than');
        });
      });
    });
  });

  describe('Given log-section positions that are individually in bounds', () => {
    describe('When the last block offset leaves no room for its own 4-byte header', () => {
      it('Then refuses with block-bounds instead of reading past the table', async () => {
        // Arrange — both positions pass a bound stated against the file
        // length: on a 92-byte v1 table, log_position 91 and
        // log_index_position 92 are each <= 92. Only a bound stated against
        // the READ catches that offset 91 leaves 1 byte where the block
        // header needs 4.
        const bytes = buildReftable({
          version: 1,
          blocks: [],
          logPosition: 91,
          logIndexPosition: 92,
        });
        const sut = loadReftable;

        // Act & Assert
        await expectReftableRefusal(sut(bytes, inflateAt), 'header bytes', 'block-bounds');
      });
    });

    describe('When log_position sits exactly at the end of the file', () => {
      it('Then reads no log blocks rather than refusing', async () => {
        // Arrange — a log section starting at EOF declares no log data at
        // all, which is legal; the bound is on positions PAST the end, so
        // equality must not refuse.
        const bytes = buildReftable({ version: 1, blocks: [], logPosition: 92 });
        const sut = loadReftable;

        // Act
        const result = await sut(bytes, inflateAt);

        // Assert
        expect(result.logBlocks).toEqual([]);
      });
    });
  });

  describe('Given a log block whose deflate stream cannot be inflated', () => {
    describe('When the table is loaded', () => {
      it('Then refuses with block-bounds rather than an unclassifiable decompression fault', async () => {
        // Arrange — a well-framed 'g' block whose payload is not a zlib
        // stream at all. DECOMPRESS_FAILED is a TsgitError but carries no
        // ReftableCheck, so it would deny the whole ref-integrity audit
        // instead of marking this one table bad.
        const garbage = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + 6);
        const view = new DataView(garbage.buffer);
        garbage[0] = 'g'.charCodeAt(0);
        view.setUint8(1, 0);
        view.setUint16(2, LOG_BLOCK_HEADER_LENGTH + 6);
        garbage.fill(0xff, LOG_BLOCK_HEADER_LENGTH);
        const bytes = buildLogOnlyReftable([garbage]);
        const sut = loadReftable;

        // Act & Assert
        await expectReftableRefusal(sut(bytes, inflateAt), 'failed to inflate', 'block-bounds');
      });
    });
  });

  describe('Given a log block whose inflation fails for a reason that is not decompression', () => {
    describe('When the thrown fault is not a TsgitError at all', () => {
      it('Then it propagates unchanged rather than being restated as a corrupt table', async () => {
        // Arrange — the restatement must stay narrow: an adapter bug is not
        // evidence that the table's bytes are bad.
        const block = await buildRawLogBlock(4);
        const bytes = buildLogOnlyReftable([block]);
        const fault = new Error('adapter exploded');
        const sut = loadReftable;

        // Act
        const result = await sut(bytes, () => Promise.reject(fault)).catch((err: unknown) => err);

        // Assert
        expect(result).toBe(fault);
      });
    });

    describe('When the thrown fault is a TsgitError carrying a different code', () => {
      it('Then it propagates unchanged rather than being restated as a corrupt table', async () => {
        // Arrange
        const block = await buildRawLogBlock(4);
        const bytes = buildLogOnlyReftable([block]);
        const fault = invalidReftable('truncated', 'some other structural fault');
        const sut = loadReftable;

        // Act
        const result = await sut(bytes, () => Promise.reject(fault)).catch((err: unknown) => err);

        // Assert
        expect(result).toBe(fault);
      });
    });
  });

  describe('Given a footer whose log-section positions point past the end of the file', () => {
    describe('When log_position alone overruns the file', () => {
      it('Then refuses with block-bounds before ever reading at that offset', async () => {
        // Arrange — the measured repro: valid magic, valid version, a valid
        // footer CRC, no blocks at all (header + footer only, 92 bytes at
        // v1) — every gate before this one passes, and log_position simply
        // points past the end of the file.
        const bytes = buildReftable({ version: 1, blocks: [], logPosition: 1000 });
        const sut = loadReftable;

        // Act & Assert
        await expectReftableRefusal(sut(bytes, inflateAt), 'log_position', 'block-bounds');
      });
    });

    describe('When log_index_position alone overruns the file', () => {
      it('Then refuses with block-bounds before computing the log section end', async () => {
        // Arrange — log_position itself is in-bounds (right after the
        // header, on a table with no blocks), so only log_index_position's
        // own guard (inside logSectionEnd) can be what fires here.
        const header = buildReftableHeader({ version: 1 });
        const bytes = buildReftable({
          version: 1,
          blocks: [],
          logPosition: header.length,
          logIndexPosition: 2000,
        });
        const sut = loadReftable;

        // Act & Assert
        await expectReftableRefusal(sut(bytes, inflateAt), 'log_index_position', 'block-bounds');
      });
    });
  });

  describe('log-block record-grammar bounds', () => {
    describe('Given a log block payload too short to hold its own restart_count', () => {
      describe('When resolving its bounds', () => {
        it('Then refuses with block-bounds instead of a raw RangeError', () => {
          // Arrange — the exact shape two independent reviewers reproduced:
          // a table declaring `block_len = LOG_BLOCK_HEADER_LENGTH` (a
          // zero-byte inflated payload). `payload.length -
          // RESTART_COUNT_SIZE` goes negative, and `DataView.getUint16` on a
          // negative offset throws a raw RangeError before any
          // INVALID_REFTABLE guard gets a chance to fire.
          const payload = new Uint8Array(0);
          const sut = logBlockBounds;

          // Act
          let caught: unknown;
          try {
            sut(payload);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('block-bounds');
          expect((caught as { data: { reason: string } }).data.reason).toContain(
            'log block payload of 0 bytes is too short to hold its own restart_count',
          );
        });
      });
    });

    describe('Given a log block whose declared restart_count overruns its own payload', () => {
      describe('When resolving its bounds', () => {
        it('Then refuses with block-bounds instead of computing a negative restart array start', () => {
          // Arrange — the trailing uint16 (readable on its own, at offset 8
          // of this 10-byte payload) declares 5 restart entries, but 5 * 3
          // bytes leaves no room for them: `restartArrayStart` computes to
          // -7, and the un-guarded loop would call `readUint24` at negative
          // offsets.
          const payload = new Uint8Array(10);
          new DataView(payload.buffer).setUint16(8, 5);
          const sut = logBlockBounds;

          // Act
          let caught: unknown;
          try {
            sut(payload);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('block-bounds');
          expect((caught as { data: { reason: string } }).data.reason).toContain(
            'log block declares restart_count 5, overrunning its 10-byte payload',
          );
        });
      });
    });

    describe('Given a table whose only log block declares block_len 4 with a zero-byte inflated payload', () => {
      describe('When iterating its records via loadReftable + iterateReftableLogs', () => {
        it('Then refuses with block-bounds instead of crashing the read path with a RangeError', async () => {
          // Arrange — the end-to-end repro: the ref section is untouched (a
          // log-only table has none), so only a log walk (readReflog,
          // listReflogs, or a write appending through the loggable-names
          // scan) ever reaches this block.
          const block = await buildRawLogBlock(0);
          const bytes = buildLogOnlyReftable([block]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('block-bounds');
        });
      });
    });

    describe('Given a log record whose decoded key is shorter than the reversed update_index suffix', () => {
      describe('When iterating via iterateReftableLogs', () => {
        it('Then refuses with record-overrun instead of crashing or reading adjacent bytes', async () => {
          // Arrange — an empty key: no legitimate writer ever produces this
          // (`encodeLogKey` always emits at least the 9-byte
          // refname+separator+reverse_int64 suffix), but a hostile table can
          // declare it. `splitLogKey` used to build its `DataView` at
          // `keyBytes.byteOffset + keyBytes.length - 8` before checking the
          // key was even 8 bytes long.
          const block = await buildShortKeyLogBlock(new Uint8Array(0));
          const bytes = buildLogOnlyReftable([block]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('record-overrun');
          expect((caught as { data: { reason: string } }).data.reason).toContain(
            'log key of 0 bytes is too short to hold the 9-byte separator',
          );
        });
      });
    });

    describe('Given a log entry record whose log_data ends immediately after time_seconds, with no tz_offset bytes', () => {
      describe('When iterating via iterateReftableLogs (the unfiltered, materialising walk)', () => {
        it('Then refuses with record-overrun instead of reading the timezone past the payload', async () => {
          // Arrange — the measured repro: a 55-byte log payload that loads
          // cleanly (loadReftable never inspects record content), then the
          // audit walk's own materialise branch — the one path a name
          // filter cannot route around — throws.
          const block = await buildTruncatedTzLogBlock();
          const bytes = buildLogOnlyReftable([block]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('record-overrun');
          expect((caught as { data: { reason: string } }).data.reason).toContain(
            'tz_offset at byte 55 runs past the 55-byte payload',
          );
        });
      });
    });

    describe('Given a log entry record whose log_data is truncated to 18 bytes, short of old_id + new_id', () => {
      describe('When iterating via iterateReftableLogs (the unfiltered, materialising walk)', () => {
        it('Then refuses with record-overrun instead of handing ObjectId.fromRaw a silently truncated subarray', async () => {
          // Arrange
          const block = await buildTruncatedIdsLogBlock();
          const bytes = buildLogOnlyReftable([block]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('record-overrun');
          expect((caught as { data: { reason: string } }).data.reason).toContain(
            'needs 40 bytes for old_id + new_id, past the 30-byte payload',
          );
        });
      });
    });
  });

  describe('exact-boundary bounds checks', () => {
    describe('Given a log key exactly the width of its own separator + reversed update_index suffix', () => {
      describe('When iterating', () => {
        it('Then the width guard does not refuse — the empty ref name it decodes to refuses instead', async () => {
          // Arrange — keyBytes.length === suffixWidth (9) exactly, the
          // boundary between `<` and `<=`: the width guard must NOT report
          // "too short" here; the empty name it decodes to is what a later,
          // different guard refuses.
          const block = await buildShortKeyLogBlock(new Uint8Array(9));
          const bytes = buildLogOnlyReftable([block]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('record-overrun');
          expect((caught as { data: { reason: string } }).data.reason).not.toContain('too short');
          expect((caught as { data: { reason: string } }).data.reason).toContain('dangerous');
        });
      });
    });

    describe('Given a log entry whose log_data is exactly old_id + new_id, with nothing after', () => {
      describe('When iterating via iterateReftableLogs', () => {
        it('Then the ids guard does not refuse — the next read (name_len) refuses as truncated instead', async () => {
          // Arrange — idsEnd === bytes.length exactly, the boundary between
          // `>` and `>=`.
          const ids = new Uint8Array(40);
          const record = new Uint8Array([...entryKeyRecordPrefix(), ...ids]);
          const compressed = await deflate(record);
          const raw = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
          const view = new DataView(raw.buffer);
          raw[0] = 'g'.charCodeAt(0);
          const declared = LOG_BLOCK_HEADER_LENGTH + record.length;
          view.setUint8(1, (declared >>> 16) & 0xff);
          view.setUint16(2, declared & 0xffff);
          raw.set(compressed, LOG_BLOCK_HEADER_LENGTH);
          const bytes = buildLogOnlyReftable([raw]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert — a DIFFERENT check (`truncated`, from readVarint's own
          // guard) proves the ids guard itself passed silently at the
          // boundary.
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('truncated');
        });
      });
    });

    describe('Given a log entry whose log_data ends exactly after tz_offset, with nothing after', () => {
      describe('When iterating via iterateReftableLogs', () => {
        it('Then the tz guard does not refuse — the next read (message_len) refuses as truncated instead', async () => {
          // Arrange — afterTimestamp + TZ_OFFSET_WIDTH === bytes.length
          // exactly, the boundary between `>` and `>=`.
          const ids = new Uint8Array(40);
          const record = new Uint8Array([
            ...entryKeyRecordPrefix(),
            ...ids,
            0x00, // name_len = 0
            0x00, // email_len = 0
            0x00, // time_seconds
            0x00,
            0x00, // tz_offset, exactly filling to the end
          ]);
          const compressed = await deflate(record);
          const raw = new Uint8Array(LOG_BLOCK_HEADER_LENGTH + compressed.length);
          const view = new DataView(raw.buffer);
          raw[0] = 'g'.charCodeAt(0);
          const declared = LOG_BLOCK_HEADER_LENGTH + record.length;
          view.setUint8(1, (declared >>> 16) & 0xff);
          view.setUint16(2, declared & 0xffff);
          raw.set(compressed, LOG_BLOCK_HEADER_LENGTH);
          const bytes = buildLogOnlyReftable([raw]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          let caught: unknown;
          try {
            Array.from(sut(table));
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as { data: { code: string } }).data.code).toBe('INVALID_REFTABLE');
          expect((caught as { data: { check: string } }).data.check).toBe('truncated');
        });
      });
    });

    describe('Given a log block payload exactly 2 bytes (only its own restart_count, zero records)', () => {
      describe('When resolving its bounds', () => {
        it('Then it does not refuse — payload.length === RESTART_COUNT_SIZE is in-bounds, not too short', () => {
          // Arrange
          const payload = new Uint8Array(2);
          const sut = logBlockBounds;

          // Act
          const bounds = sut(payload);

          // Assert
          expect(bounds.recordsEnd).toBe(0);
          expect(bounds.restartOffsets).toStrictEqual([]);
        });
      });
    });

    describe('Given a log block whose restart array starts exactly at payload offset 0 (fills the whole payload)', () => {
      describe('When resolving its bounds', () => {
        it('Then it does not refuse — restartArrayStart === 0 is in-bounds, not negative', () => {
          // Arrange — 2 restart entries (6 bytes) + the trailing restart_count
          // (2 bytes) exactly fill an 8-byte payload, leaving 0 bytes for
          // records: restartArrayStart computes to exactly 0.
          const payload = new Uint8Array(8);
          new DataView(payload.buffer).setUint16(6, 2);
          const sut = logBlockBounds;

          // Act
          const bounds = sut(payload);

          // Assert
          expect(bounds.recordsEnd).toBe(0);
          expect(bounds.restartOffsets).toHaveLength(2);
        });
      });
    });

    describe('Given a log block payload with two restart entries at known offsets', () => {
      describe('When resolving its bounds', () => {
        it('Then each entry is read from its OWN position, not a mis-indexed shared one', () => {
          // Arrange — deterministic, hand-placed restart entries (never real
          // record bytes) so the expected offsets are known exactly, rather
          // than inferred from record encoding.
          function writeUint24(view: DataView, offset: number, value: number): void {
            view.setUint8(offset, (value >>> 16) & 0xff);
            view.setUint16(offset + 1, value & 0xffff);
          }
          const arrayStart = 20;
          const payload = new Uint8Array(arrayStart + 3 + 3 + 2);
          const view = new DataView(payload.buffer);
          writeUint24(view, arrayStart, 4);
          writeUint24(view, arrayStart + 3, 777);
          view.setUint16(arrayStart + 6, 2);
          const sut = logBlockBounds;

          // Act
          const bounds = sut(payload);

          // Assert
          expect(bounds.restartOffsets).toStrictEqual([4, 777]);
        });
      });
    });

    describe('Given a log block with a tombstone for one name and a filter for a different name', () => {
      describe('When iterating filtered to the other name', () => {
        it('Then the non-matching tombstone is not yielded', async () => {
          // Arrange
          const block = await buildReftableLogBlock(
            {
              records: [
                { refName: 'refs/heads/gone', updateIndex: 1n, entry: { kind: 'deletion' } },
              ],
            },
            deflate,
          );
          const bytes = buildLogOnlyReftable([block]);
          const table = await loadReftable(bytes, inflateAt);
          const sut = iterateReftableLogs;

          // Act
          const records = Array.from(sut(table, RefName.from('refs/heads/other')));

          // Assert
          expect(records).toStrictEqual([]);
        });
      });
    });

    describe('Given a log-block position exactly 4 bytes before the end of the file (touching the footer)', () => {
      describe('When loading the table', () => {
        it('Then the header-room guard does not refuse — a later guard (the per-block budget) does instead', async () => {
          // Arrange — offset + LOG_BLOCK_HEADER_LENGTH === table._bytes.length
          // exactly, the boundary between `>` and `>=`. The 3 header bytes
          // read from this position land inside the footer's CRC field,
          // deterministically producing a declared size far past the
          // default per-block budget — never the header-room guard's own
          // ('needs 4 header bytes, past the') message.
          const bytes = buildReftable({
            version: 1,
            blocks: [],
            logPosition: 88,
            logIndexPosition: 92,
          });
          const sut = loadReftable;

          // Act & Assert
          await expectReftableRefusal(sut(bytes, inflateAt), 'per-block limit', 'block-bounds');
        });
      });
    });

    describe('Given a log block whose declared size is exactly the per-block budget', () => {
      describe('When loading the table', () => {
        it('Then it does not refuse — declaredPayloadBytes === maxBlockBytes is in-bounds, not over budget', async () => {
          // Arrange
          const block = await buildRawLogBlock(50);
          const bytes = buildLogOnlyReftable([block]);
          const budget: LogInflationBudget = { maxBlockBytes: 50, maxTableBytes: 1000 };
          const sut = loadReftable;

          // Act
          const table = await sut(bytes, inflateAt, budget);

          // Assert
          expect(table.logBlocks).toHaveLength(1);
          expect(table.logBlocks[0]).toHaveLength(50);
        });
      });
    });

    describe('Given log blocks whose combined size is exactly the per-table budget', () => {
      describe('When loading the table', () => {
        it('Then it does not refuse — totalInflatedBytes === maxTableBytes is in-bounds, not over budget', async () => {
          // Arrange
          const block = await buildRawLogBlock(50);
          const bytes = buildLogOnlyReftable([block]);
          const budget: LogInflationBudget = { maxBlockBytes: 1000, maxTableBytes: 50 };
          const sut = loadReftable;

          // Act
          const table = await sut(bytes, inflateAt, budget);

          // Assert
          expect(table.logBlocks).toHaveLength(1);
          expect(table.logBlocks[0]).toHaveLength(50);
        });
      });
    });
  });
});

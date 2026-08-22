import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryCompressor } from '../../../../../src/adapters/memory/memory-compressor.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import { iterateReftableRefs } from '../../../../../src/domain/refs/reftable/reftable-block.js';
import { parseReftable } from '../../../../../src/domain/refs/reftable/reftable-format.js';
import {
  iterateReftableLogs,
  loadReftable,
  type ReftableLogRecord,
} from '../../../../../src/domain/refs/reftable/reftable-log.js';
import {
  canonicaliseLogMessage,
  serializeReftable,
} from '../../../../../src/domain/refs/reftable/reftable-writer.js';
import { arbLogRecord, arbRefRecord, arbWriteOptions, buildReftable } from './arbitraries.js';

const compressor = new MemoryCompressor();

function canonicaliseExpectedLog(record: ReftableLogRecord): ReftableLogRecord {
  if (record.entry.kind !== 'entry') {
    return record;
  }
  return {
    ...record,
    entry: { ...record.entry, message: canonicaliseLogMessage(record.entry.message) },
  };
}

function logSortKey(record: ReftableLogRecord): string {
  // Sorts ascending by name, then descending (reverse) by update_index — the
  // same `refname '\0' reverse_int64(update_index)` ordering the on-disk log
  // key encodes, restated over comparable strings for the test oracle.
  const reversedUpdateIndex = (0xffffffffffffffffn - record.updateIndex)
    .toString()
    .padStart(20, '0');
  return `${record.name}\0${reversedUpdateIndex}`;
}

/**
 * Every `arbRefRecord`/`arbLogRecord` draw, deduplicated on the key that
 * must be unique within one reftable: ref name for refs, `(name,
 * update_index)` for logs — a real writer never receives two live records
 * for the same key in one transaction.
 *
 * `blockSize` folds the generator's 512 draw into 4096: the reader only
 * descends into a second ref block through the ref index, and an index is
 * only emitted at 4+ blocks, so a ref section landing at 2-3 blocks with no
 * index is unreachable past its first block by the existing reader — a
 * pre-existing gap outside this part's scope. `blockSize` 0 is
 * unconditionally single-block by this writer's own overflow guard, and
 * 4096 comfortably holds every record this bounded scenario can generate,
 * so both remaining choices stay inside the reader's covered regime while
 * still exercising the aligned/unaligned split.
 */
function arbReftableScenario() {
  return arbWriteOptions()
    .map((opts) => (opts.blockSize === 512 ? { ...opts, blockSize: 4096 } : opts))
    .chain((opts) =>
      fc.record({
        opts: fc.constant(opts),
        refs: fc.uniqueArray(arbRefRecord(opts.hashId), { selector: (r) => r.name, maxLength: 8 }),
        logs: fc.uniqueArray(arbLogRecord(opts.hashId), {
          selector: (r) => `${r.name}\0${r.updateIndex}`,
          maxLength: 8,
        }),
      }),
    );
}

describe('reftable writer properties', () => {
  describe('Given an arbitrary set of refs, logs and write options', () => {
    describe('When serializing then loading', () => {
      it('Then every ref and log record round-trips modulo the documented canonicalisation', async () => {
        // Arrange
        const sut = serializeReftable;

        // Act + Assert
        await fc.assert(
          fc.asyncProperty(arbReftableScenario(), async ({ opts, refs, logs }) => {
            // serializeReftable trusts its caller to have already sorted
            // both inputs (refs by name, logs by (name, reverse
            // update_index)) rather than re-deriving that order itself —
            // the property honours that precondition the same way a real
            // caller (the reftable transaction) does.
            const sortedRefs = [...refs].sort((a, b) => (a.name < b.name ? -1 : 1));
            const sortedLogs = [...logs].sort((a, b) => (logSortKey(a) < logSortKey(b) ? -1 : 1));

            const bytes = await sut(sortedRefs, sortedLogs, opts, compressor.deflate);
            const loaded = await loadReftable(bytes, compressor.streamInflate);

            // (i) refs compared as a set keyed by name, not by array order.
            const expectedRefs = new Map(refs.map((r) => [r.name, r]));
            const actualRefs = new Map([...iterateReftableRefs(loaded)].map((r) => [r.name, r]));
            expect(actualRefs).toEqual(expectedRefs);

            // (ii) logs compared sorted by (name, reverse update_index);
            // (iii) messages compared through canonicaliseLogMessage, never
            // the raw generated string; (iv) update_index compared as the
            // absolute value the delta decodes back to.
            const expectedLogs = sortedLogs.map(canonicaliseExpectedLog);
            const actualLogs = [...iterateReftableLogs(loaded)];
            expect(actualLogs).toEqual(expectedLogs);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given a byte string that may or may not be a well-formed reftable', () => {
    describe('When parsing it', () => {
      it('Then it either parses or refuses with INVALID_REFTABLE — never any other throw', () => {
        // Arrange
        const sut = parseReftable;

        // Half the runs are raw random bytes (almost never survive the
        // magic gate); half start from a VALID built table and corrupt a
        // window of it, the only generation that drives the parser past
        // its early size/magic gates with in-bounds-looking values — the
        // same trick test/unit/domain/storage/rev-index.properties.test.ts
        // uses.
        const rawBytes = fc.uint8Array({ minLength: 0, maxLength: 2048, size: 'max' });
        const corruptedBuilt = fc.constantFrom<1 | 2>(1, 2).chain((version) => {
          const built = buildReftable(version === 2 ? { version, hashId: 'sha1' } : { version });
          return fc
            .tuple(
              fc.nat({ max: Math.max(0, built.length - 1) }),
              fc.uint8Array({ minLength: 1, maxLength: 24 }),
            )
            .map(([start, patch]) => {
              const corrupted = built.slice();
              corrupted.set(patch.subarray(0, corrupted.length - start), start);
              return corrupted;
            });
        });

        // Act + Assert
        fc.assert(
          fc.property(fc.oneof(rawBytes, corruptedBuilt), (bytes) => {
            try {
              sut(bytes);
            } catch (e) {
              const data = (e as TsgitError).data;
              expect(data.code).toBe('INVALID_REFTABLE');
            }
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});

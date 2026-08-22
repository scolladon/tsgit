import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../../../../../src/domain/objects/encoding.js';
import { ObjectId, type RefName } from '../../../../../src/domain/objects/index.js';
import {
  DEFAULT_GEOMETRIC_FACTOR,
  suggestCompactionSegment,
} from '../../../../../src/domain/refs/reftable/reftable-compaction.js';
import { parseReftable } from '../../../../../src/domain/refs/reftable/reftable-format.js';
import type { LoadedReftable } from '../../../../../src/domain/refs/reftable/reftable-log.js';
import { createReftableStack } from '../../../../../src/domain/refs/reftable/reftable-stack.js';
import { arbObjectId } from '../../objects/arbitraries.js';
import { arbRefName } from '../arbitraries.js';
import { buildRefBlock, buildReftable, buildReftableHeader } from './arbitraries.js';

// --- Stack merge-join property --------------------------------------------

type Operation = { readonly kind: 'live'; readonly idHex: string } | { readonly kind: 'deletion' };

function arbOperation(): fc.Arbitrary<Operation> {
  return fc.oneof(
    arbObjectId(40).map((idHex): Operation => ({ kind: 'live', idHex })),
    fc.constant<Operation>({ kind: 'deletion' }),
  );
}

/** One single-record table for `name` at `updateIndex` — a live direct ref
 *  or a tombstone, never both (never a real reftable's shape either). */
function buildSingleRecordTable(name: RefName, updateIndex: bigint, op: Operation): LoadedReftable {
  const headerSpec = {
    version: 1 as const,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
  };
  const header = buildReftableHeader(headerSpec);
  const value =
    op.kind === 'deletion'
      ? { kind: 'deletion' as const }
      : { kind: 'direct' as const, id: hexToBytes(op.idHex) };
  const block = buildRefBlock({
    records: [{ name, updateIndexDelta: 0, value }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  const bytes = buildReftable({ ...headerSpec, blocks: [block] });
  return { ...parseReftable(bytes), logBlocks: [] };
}

function assertMatchesLastOperation(
  operations: readonly Operation[],
  found: ReturnType<ReturnType<typeof createReftableStack>['lookup']>,
  isPresent: boolean,
): void {
  const last = operations[operations.length - 1];
  if (last === undefined || last.kind === 'deletion') {
    expect(found).toBeUndefined();
    expect(isPresent).toBe(false);
    return;
  }
  expect(found?.value).toStrictEqual({
    kind: 'direct',
    id: ObjectId.fromRaw(hexToBytes(last.idHex)),
  });
  expect(isPresent).toBe(true);
}

// --- Compaction convergence property ---------------------------------------

/** Merges `[segment.start, segment.end)` into one entry — its metric is the
 *  simple sum of the merged range. A real merged table's metric is always
 *  *smaller* than this sum (shared framing overhead), so the sum is a
 *  conservative stand-in: it never manufactures a merge opportunity the real
 *  writer would not also have. The property below tests the segment-finder's
 *  own termination shape, not the writer's exact byte arithmetic — that is
 *  pinned separately by the measured-transition tables. */
function applySegment(sizes: readonly number[], start: number, end: number): readonly number[] {
  if (start === end) {
    return sizes;
  }
  const merged = sizes.slice(start, end).reduce((sum, size) => sum + size, 0);
  return [...sizes.slice(0, start), merged, ...sizes.slice(end)];
}

describe('reftable-stack properties', () => {
  describe('Given an arbitrary sequence of live/tombstone operations for one ref name', () => {
    describe('When folding them into a stack, oldest table first', () => {
      it('Then lookup() and names() reflect exactly the last operation, and an empty stack has neither', () => {
        // Arrange
        const sut = createReftableStack;

        // Act + Assert
        fc.assert(
          fc.property(
            arbRefName(),
            fc.array(arbOperation(), { maxLength: 8 }),
            (name, operations) => {
              const tables = operations.map((op, index) =>
                buildSingleRecordTable(name, BigInt(index + 1), op),
              );
              const stack = sut(tables);

              const found = stack.lookup(name);
              const isPresent = new Set(Array.from(stack.names())).has(name);

              assertMatchesLastOperation(operations, found, isPresent);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary vector of table size metrics', () => {
    describe('When repeatedly applying the suggested compaction segment', () => {
      it('Then it converges to an empty segment within at most one iteration per table', () => {
        // Arrange
        const sut = suggestCompactionSegment;

        // Act + Assert
        fc.assert(
          fc.property(
            fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 12 }),
            (sizes) => {
              let current: readonly number[] = sizes;
              for (let iteration = 0; iteration <= sizes.length; iteration += 1) {
                const { start, end } = sut(current, DEFAULT_GEOMETRIC_FACTOR);
                if (start === 0 && end === 0) {
                  return;
                }
                current = applySegment(current, start, end);
              }
              expect.fail(
                `did not converge to a geometric stack within ${sizes.length} iterations`,
              );
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

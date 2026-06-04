import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  enqueue,
  precedes,
  type QueueEntry,
} from '../../../../src/domain/commit/priority-queue.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

// Small alphabets so equal-date and equal-oid ties occur often enough to exercise
// the oid tie-break and the stable full-equality branch.
const oidArb: fc.Arbitrary<ObjectId> = fc
  .constantFrom('a', 'b', 'c', 'd')
  .map((char) => char.repeat(40) as ObjectId);

const orderedArb = fc.record({ oid: oidArb, date: fc.integer({ min: 0, max: 4 }) });

const entriesArb: fc.Arbitrary<QueueEntry<number>[]> = fc
  .array(orderedArb, { maxLength: 12 })
  .map((rows) => rows.map((row, index) => ({ ...row, value: index })));

const drainAll = (entries: ReadonlyArray<QueueEntry<number>>): QueueEntry<number>[] => {
  const queue: QueueEntry<number>[] = [];
  for (const entry of entries) enqueue(queue, entry);
  return queue;
};

describe('Given an arbitrary ordered pair, When comparing with precedes', () => {
  it('Then no entry precedes itself', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(orderedArb, (sut) => {
        expect(precedes(sut, sut)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('Then precedes is asymmetric', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(orderedArb, orderedArb, (a, b) => {
        if (precedes(a, b)) expect(precedes(b, a)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('Then exactly one direction precedes for any two distinct entries', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(orderedArb, orderedArb, (a, b) => {
        // Arrange
        const distinct = a.date !== b.date || a.oid !== b.oid;
        fc.pre(distinct);

        // Act + Assert — a strict total order on (date desc, oid asc).
        expect(precedes(a, b) !== precedes(b, a)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('Given an arbitrary sequence of entries, When enqueuing each in turn', () => {
  it('Then the queue holds every entry exactly once', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(entriesArb, (entries) => {
        // Act
        const sut = drainAll(entries);

        // Assert — no drops, no duplicates: same values, ignoring order.
        const drainedValues = sut.map((entry) => entry.value).sort((x, y) => x - y);
        const sourceValues = entries.map((entry) => entry.value).sort((x, y) => x - y);
        expect(drainedValues).toEqual(sourceValues);
      }),
      { numRuns: 100 },
    );
  });

  it('Then no element precedes its predecessor (ordered newest-first)', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(entriesArb, (entries) => {
        // Act
        const sut = drainAll(entries);

        // Assert — the spec of a sorted insert: a later element never outranks an earlier one.
        for (let i = 1; i < sut.length; i += 1) {
          expect(precedes(sut[i]!, sut[i - 1]!)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});

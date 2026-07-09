import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BinaryHeap } from '../../../../src/domain/commit/binary-heap.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

// Small alphabets so equal-date and equal-oid ties occur often enough to exercise
// the oid tie-break and the heap's sift comparisons under contention.
const oidArb: fc.Arbitrary<ObjectId> = fc
  .constantFrom('a', 'b', 'c', 'd')
  .map((char) => char.repeat(40) as ObjectId);

const orderedArb = fc.record({ oid: oidArb, date: fc.integer({ min: 0, max: 4 }) });

interface Entry {
  readonly oid: ObjectId;
  readonly date: number;
  readonly value: number;
}

const entriesArb: fc.Arbitrary<Entry[]> = fc
  .array(orderedArb, { maxLength: 12 })
  .map((rows) => rows.map((row, index) => ({ ...row, value: index })));

/** Mirrors priority-queue's `precedes`: newest date first, oid-ascending on equal dates. */
const less = (a: Entry, b: Entry): boolean =>
  a.date > b.date || (a.date === b.date && a.oid < b.oid);

const byLess = (a: Entry, b: Entry): number => {
  if (less(a, b)) return -1;
  if (less(b, a)) return 1;
  return 0;
};

const pushAll = (entries: ReadonlyArray<Entry>): BinaryHeap<Entry> => {
  const heap = new BinaryHeap<Entry>(less);
  for (const entry of entries) heap.push(entry);
  return heap;
};

const drain = (heap: BinaryHeap<Entry>): Entry[] => {
  const drained: Entry[] = [];
  let next = heap.pop();
  while (next !== undefined) {
    drained.push(next);
    next = heap.pop();
  }
  return drained;
};

/** Projects an entry onto the fields `less` actually compares, so ties compare equal. */
const precedesProjection = (entry: Entry): readonly [number, ObjectId] => [-entry.date, entry.oid];

describe('Given an arbitrary sequence of entries, When pushed then fully drained', () => {
  it('Then the drain order matches the Array.sort oracle', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(entriesArb, (entries) => {
        // Arrange
        const sut = pushAll(entries);

        // Act
        const result = drain(sut);

        // Assert — compare the precedes-invariant projection so genuine ties (equal
        // date+oid but different value) don't spuriously fail: Array.sort is not
        // guaranteed to agree with the heap's sift order on fully-equal keys.
        const expected = entries.slice().sort(byLess).map(precedesProjection);
        expect(result.map(precedesProjection)).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });
});

describe('Given an arbitrary sequence of entries, When drained one at a time', () => {
  it('Then no popped element outranks its predecessor', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(entriesArb, (entries) => {
        // Arrange
        const sut = pushAll(entries);

        // Act
        const result = drain(sut);

        // Assert — the heap's pop invariant: a later pop never precedes an earlier one.
        for (let i = 1; i < result.length; i += 1) {
          expect(less(result[i]!, result[i - 1]!)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('Then the drained multiset equals the pushed multiset', () => {
    // Arrange + Act + Assert
    fc.assert(
      fc.property(entriesArb, (entries) => {
        // Arrange
        const sut = pushAll(entries);

        // Act
        const result = drain(sut);

        // Assert — no drops, no duplicates: same values, ignoring order.
        const drainedValues = result.map((entry) => entry.value).sort((x, y) => x - y);
        const sourceValues = entries.map((entry) => entry.value).sort((x, y) => x - y);
        expect(drainedValues).toEqual(sourceValues);
      }),
      { numRuns: 100 },
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { precedes } from '../../../../src/domain/commit/priority-queue.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

// Small alphabets so equal-date and equal-oid ties occur often enough to exercise
// the oid tie-break and the stable full-equality branch.
const oidArb: fc.Arbitrary<ObjectId> = fc
  .constantFrom('a', 'b', 'c', 'd')
  .map((char) => char.repeat(40) as ObjectId);

const orderedArb = fc.record({ oid: oidArb, date: fc.integer({ min: 0, max: 4 }) });

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

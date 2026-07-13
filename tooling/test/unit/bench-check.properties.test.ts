import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SnapshotEntry } from '../../bench-to-snapshot.js';
import { compareToBaseline } from '../../bench-check.js';
import { gatedEntrySetArb } from './arbitraries.js';

const THRESHOLD_PCT = 10;
const EPSILON = 1;

const entry = (name: string, value: number): SnapshotEntry => ({ name, unit: 'ms', value });

describe('Given an arbitrary gated entry set', () => {
  describe('When base and current are both empty', () => {
    it('Then compareToBaseline returns no rows and does not fail (identity)', () => {
      // Arrange
      const sut = compareToBaseline;

      // Act
      const result = sut([], [], { thresholdPct: THRESHOLD_PCT });

      // Assert
      expect(result.rows).toEqual([]);
      expect(result.failed).toBe(false);
    });
  });

  describe('When a regressing pair is appended to both sides of a non-flagging set', () => {
    it('Then failed flips to true', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(gatedEntrySetArb(), (entries) => {
          const baseline = compareToBaseline(entries, entries, { thresholdPct: THRESHOLD_PCT });
          fc.pre(!baseline.failed);

          const regressedValue = 100 * (1 + (THRESHOLD_PCT + EPSILON) / 100);
          const regressingBase = [...entries, entry('zzz-regress > tsgit', 100)];
          const regressingCurrent = [...entries, entry('zzz-regress > tsgit', regressedValue)];

          const result = compareToBaseline(regressingBase, regressingCurrent, {
            thresholdPct: THRESHOLD_PCT,
          });

          expect(result.failed).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('When only stable pairs are appended to a non-flagging set', () => {
    it('Then failed stays false (improvements and below-threshold deltas never flip it)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          gatedEntrySetArb(),
          fc.double({ min: -50, max: THRESHOLD_PCT - EPSILON, noNaN: true }),
          (entries, deltaPct) => {
            const baseline = compareToBaseline(entries, entries, { thresholdPct: THRESHOLD_PCT });
            fc.pre(!baseline.failed);

            const stableValue = 100 * (1 + deltaPct / 100);
            const stableBase = [...entries, entry('zzz-stable > tsgit', 100)];
            const stableCurrent = [...entries, entry('zzz-stable > tsgit', stableValue)];

            const result = compareToBaseline(stableBase, stableCurrent, {
              thresholdPct: THRESHOLD_PCT,
            });

            expect(result.failed).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

import { describe, expect, it } from 'vitest';

import type { SnapshotEntry } from '../../bench-to-snapshot.js';
import { compareToBaseline, gatedEntries } from '../../bench-check.js';

const entry = (name: string, value: number): SnapshotEntry => ({ name, unit: 'ms', value });

describe('compareToBaseline', () => {
  describe('Given a scenario that regresses above the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is flagged regress and failed is true', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 120)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(20);
        expect(result.rows[0]?.verdict).toBe('regress');
        expect(result.failed).toBe(true);
      });
    });
  });

  describe('Given a scenario that stays below the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row passes and failed is false', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 105)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(5);
        expect(result.rows[0]?.verdict).toBe('pass');
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario whose delta lands exactly at the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row passes (strict greater-than, not greater-or-equal)', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 110)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(10);
        expect(result.rows[0]?.verdict).toBe('pass');
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario whose delta lands one step above the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row regresses', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 111)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(11);
        expect(result.rows[0]?.verdict).toBe('regress');
        expect(result.failed).toBe(true);
      });
    });
  });

  describe('Given a scenario that improves', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row never regresses (asymmetric comparator)', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 50)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(-50);
        expect(result.rows[0]?.verdict).toBe('pass');
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario present only in current', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict new with null baseMs and deltaPct', () => {
        // Arrange
        const base: SnapshotEntry[] = [];
        const current = [entry('y > tsgit', 42)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('new');
        expect(result.rows[0]?.baseMs).toBeNull();
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario present only in base', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict missing with null currentMs and deltaPct', () => {
        // Arrange
        const base = [entry('z > tsgit', 42)];
        const current: SnapshotEntry[] = [];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('missing');
        expect(result.rows[0]?.currentMs).toBeNull();
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario whose base value is zero', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict missing with a null (never Infinity) deltaPct', () => {
        // Arrange
        const base = [entry('w > tsgit', 0)];
        const current = [entry('w > tsgit', 5)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('missing');
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given entries from both tsgit and isomorphic-git', () => {
    describe('When gatedEntries filters them', () => {
      it('Then only the tsgit-suffixed entry remains', () => {
        // Arrange
        const mixed = [entry('s > tsgit', 10), entry('s > isomorphic-git', 20)];
        const sut = gatedEntries;

        // Act
        const result = sut(mixed);

        // Assert
        expect(result).toEqual([entry('s > tsgit', 10)]);
      });
    });
  });

  describe('Given gated tsgit-only entries fed into compareToBaseline', () => {
    describe('When compareToBaseline runs', () => {
      it('Then no row key ends in isomorphic-git', () => {
        // Arrange
        const mixedBase = [entry('s > tsgit', 10), entry('s > isomorphic-git', 20)];
        const mixedCurrent = [entry('s > tsgit', 11), entry('s > isomorphic-git', 22)];
        const sut = compareToBaseline;

        // Act
        const result = sut(gatedEntries(mixedBase), gatedEntries(mixedCurrent), {
          thresholdPct: 10,
        });

        // Assert
        expect(result.rows.every((row) => !row.key.endsWith('isomorphic-git'))).toBe(true);
      });
    });
  });

  describe('Given no entries on either side', () => {
    describe('When compareToBaseline runs', () => {
      it('Then rows is empty and failed is false', () => {
        // Arrange
        const base: SnapshotEntry[] = [];
        const current: SnapshotEntry[] = [];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows).toEqual([]);
        expect(result.failed).toBe(false);
      });
    });
  });
});

import { describe, expect, it } from 'vitest';

import { compareAbRounds, intersectBenchFiles, planRounds, renderAbTable } from '../../bench-ab.js';
import type { RawReport } from '../../bench-to-snapshot.js';

const THRESHOLD_PCT = 10;

const rawReport = (fileBasename: string, describeTitle: string, medianMs: number): RawReport => ({
  files: [
    {
      groups: [
        {
          fullName: `test/bench/${fileBasename}.bench.ts > ${describeTitle}`,
          benchmarks: [{ name: 'tsgit', mean: medianMs, median: medianMs }],
        },
      ],
    },
  ],
});

describe('intersectBenchFiles', () => {
  describe('Given two bench-file lists that differ', () => {
    describe('When the driver intersects them', () => {
      it('Then only files present in both are run', () => {
        // Arrange
        const baseFiles = ['test/bench/add.bench.ts', 'test/bench/log.bench.ts'];
        const headFiles = ['test/bench/log.bench.ts', 'test/bench/status.bench.ts'];
        const sut = intersectBenchFiles;

        // Act
        const result = sut(baseFiles, headFiles);

        // Assert
        expect(result).toEqual(['test/bench/log.bench.ts']);
      });
    });
  });
});

describe('planRounds', () => {
  describe('Given four alternating rounds', () => {
    describe('When the driver plans two rounds per side', () => {
      it('Then the base and head round paths alternate and each side gets two entries', () => {
        // Arrange
        const sut = planRounds;

        // Act
        const result = sut(2);

        // Assert
        expect(result.map((step) => step.side)).toEqual(['base', 'head', 'base', 'head']);
        expect(result.filter((step) => step.side === 'base').map((step) => step.round)).toEqual([
          1, 2,
        ]);
        expect(result.filter((step) => step.side === 'head').map((step) => step.round)).toEqual([
          1, 2,
        ]);
      });
    });
  });
});

describe('renderAbTable', () => {
  describe('Given a comparison result', () => {
    describe('When the driver renders the table', () => {
      it('Then the table carries absolute Base (ms) and Current (ms) columns', () => {
        // Arrange
        const result = compareAbRounds(
          [rawReport('log', 'Given a repo, When log runs, Then measure', 100)],
          [rawReport('log', 'Given a repo, When log runs, Then measure', 90)],
          THRESHOLD_PCT,
        );
        const sut = renderAbTable;

        // Act
        const table = sut(result, THRESHOLD_PCT);

        // Assert
        expect(table).toContain('| Scenario | Base (ms) | Current (ms) | Delta | Verdict |');
        expect(table).toContain('100.00');
        expect(table).toContain('90.00');
      });

      it('Then an operation absent from hot-paths.json is still reported', () => {
        // Arrange — "add" is not in docs/perf/hot-paths.json's hotOperations;
        // a comparison that dropped it would prove bench-check.ts's
        // hot-paths filter leaked into this driver.
        const result = compareAbRounds(
          [rawReport('add', 'Given a repo, When add runs, Then measure', 50)],
          [rawReport('add', 'Given a repo, When add runs, Then measure', 55)],
          THRESHOLD_PCT,
        );
        const sut = renderAbTable;

        // Act
        const table = sut(result, THRESHOLD_PCT);

        // Assert
        expect(table).toContain('add.bench.ts');
      });
    });
  });
});

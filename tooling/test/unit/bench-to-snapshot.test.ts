import { describe, expect, it } from 'vitest';

import { type RawReport, toSnapshotEntries } from '../../bench-to-snapshot.js';

describe('toSnapshotEntries', () => {
  describe("Given a report with no files", () => {
    describe("When toSnapshotEntries runs", () => {
      it('Then it returns an empty array', () => {
    // Arrange
    const report: RawReport = { files: [] };

    // Act
    const sut = toSnapshotEntries(report);

    // Assert
    expect(sut).toEqual([]);
  });
    });
  });

  describe("Given a benchmark with a median", () => {
    describe("When toSnapshotEntries runs", () => {
      it('Then the entry value is the median', () => {
    // Arrange
    const report: RawReport = {
      files: [
        { groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit', mean: 9, median: 4 }] }] },
      ],
    };

    // Act
    const sut = toSnapshotEntries(report);

    // Assert
    expect(sut).toEqual([{ name: 'log:walk > tsgit', unit: 'ms', value: 4 }]);
  });
    });
  });

  describe("Given a benchmark with no median", () => {
    describe("When toSnapshotEntries runs", () => {
      it('Then the entry value falls back to the mean', () => {
    // Arrange
    const report: RawReport = {
      files: [{ groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit', mean: 9 }] }] }],
    };

    // Act
    const sut = toSnapshotEntries(report);

    // Assert
    expect(sut).toEqual([{ name: 'log:walk > tsgit', unit: 'ms', value: 9 }]);
  });
    });
  });

  describe("Given a report with multiple groups", () => {
    describe("When toSnapshotEntries runs", () => {
      it('Then every group-benchmark pair becomes a named entry', () => {
    // Arrange
    const report: RawReport = {
      files: [
        {
          groups: [
            {
              fullName: 'log:walk',
              benchmarks: [
                { name: 'tsgit', mean: 1, median: 1 },
                { name: 'isomorphic-git', mean: 2, median: 2 },
              ],
            },
            { fullName: 'status:clean', benchmarks: [{ name: 'tsgit', mean: 3, median: 3 }] },
          ],
        },
      ],
    };

    // Act
    const sut = toSnapshotEntries(report);

    // Assert
    expect(sut).toEqual([
      { name: 'log:walk > tsgit', unit: 'ms', value: 1 },
      { name: 'log:walk > isomorphic-git', unit: 'ms', value: 2 },
      { name: 'status:clean > tsgit', unit: 'ms', value: 3 },
    ]);
  });
    });
  });
});

import { describe, expect, it } from 'vitest';

import { type RawReport, resolveNodeVersion, toSnapshotEntries } from '../../bench-to-snapshot.js';

describe('toSnapshotEntries', () => {
  describe('Given a report with no files', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then it returns an empty array', () => {
        // Arrange
        const report: RawReport = { files: [] };

        // Act
        const result = toSnapshotEntries(report, '24.19.0');

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a benchmark with a median', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then the entry value is the median and carries the resolved version', () => {
        // Arrange
        const report: RawReport = {
          files: [
            {
              groups: [
                { fullName: 'log:walk', benchmarks: [{ name: 'tsgit', mean: 9, median: 4 }] },
              ],
            },
          ],
        };

        // Act
        const result = toSnapshotEntries(report, '24.19.0');

        // Assert
        expect(result).toEqual([
          { name: 'log:walk > tsgit', unit: 'ms', value: 4, extra: '24.19.0' },
        ]);
      });
    });
  });

  describe('Given a benchmark with no median', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then the entry value falls back to the mean', () => {
        // Arrange
        const report: RawReport = {
          files: [{ groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit', mean: 9 }] }] }],
        };

        // Act
        const result = toSnapshotEntries(report, '24.19.0');

        // Assert
        expect(result).toEqual([
          { name: 'log:walk > tsgit', unit: 'ms', value: 9, extra: '24.19.0' },
        ]);
      });
    });
  });

  describe('Given a report with multiple groups', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then every group-benchmark pair becomes a named entry carrying the resolved version', () => {
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
        const result = toSnapshotEntries(report, '24.19.0');

        // Assert
        expect(result).toEqual([
          { name: 'log:walk > tsgit', unit: 'ms', value: 1, extra: '24.19.0' },
          { name: 'log:walk > isomorphic-git', unit: 'ms', value: 2, extra: '24.19.0' },
          { name: 'status:clean > tsgit', unit: 'ms', value: 3, extra: '24.19.0' },
        ]);
      });
    });
  });
});

describe('resolveNodeVersion', () => {
  describe('Given the resolved-version env var is absent', () => {
    describe('When resolveNodeVersion runs', () => {
      it('Then it refuses, naming the missing variable', () => {
        // Arrange
        const env = {};

        // Act
        let thrown: unknown;
        try {
          resolveNodeVersion(env);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('RESOLVED_NODE_VERSION');
      });
    });
  });

  describe('Given the resolved-version env var is an empty string', () => {
    describe('When resolveNodeVersion runs', () => {
      it('Then it refuses, naming the missing variable', () => {
        // Arrange
        const env = { RESOLVED_NODE_VERSION: '' };

        // Act
        let thrown: unknown;
        try {
          resolveNodeVersion(env);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('RESOLVED_NODE_VERSION');
      });
    });
  });

  describe('Given the resolved-version env var still contains the alias wildcard', () => {
    describe('When resolveNodeVersion runs', () => {
      it('Then it refuses, naming the offending value', () => {
        // Arrange
        const env = { RESOLVED_NODE_VERSION: 'lts/*' };

        // Act
        let thrown: unknown;
        try {
          resolveNodeVersion(env);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('lts/*');
      });
    });
  });

  describe('Given the resolved-version env var still contains an alias slash', () => {
    describe('When resolveNodeVersion runs', () => {
      it('Then it refuses, naming the offending value', () => {
        // Arrange
        const env = { RESOLVED_NODE_VERSION: 'lts/-1' };

        // Act
        let thrown: unknown;
        try {
          resolveNodeVersion(env);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('lts/-1');
      });
    });
  });

  describe('Given a resolved, non-alias version', () => {
    describe('When resolveNodeVersion runs', () => {
      it('Then it returns the version unchanged', () => {
        // Arrange
        const env = { RESOLVED_NODE_VERSION: '24.19.0' };

        // Act
        const result = resolveNodeVersion(env);

        // Assert
        expect(result).toBe('24.19.0');
      });
    });
  });
});

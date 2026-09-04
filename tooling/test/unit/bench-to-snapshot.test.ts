import { describe, expect, it } from 'vitest';

import {
  assertEveryBenchmarkValued,
  type RawReport,
  resolveNodeVersion,
  toSnapshotEntries,
  withNodeVersion,
} from '../../bench-to-snapshot.js';

describe('toSnapshotEntries', () => {
  describe('Given a report with no files', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then it returns an empty array', () => {
        // Arrange
        const report: RawReport = { files: [] };

        // Act
        const result = toSnapshotEntries(report);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a benchmark with a median', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then the entry value is the median, with no extra field', () => {
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
        const result = toSnapshotEntries(report);

        // Assert
        expect(result).toEqual([{ name: 'log:walk > tsgit', unit: 'ms', value: 4 }]);
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
        const result = toSnapshotEntries(report);

        // Assert
        expect(result).toEqual([{ name: 'log:walk > tsgit', unit: 'ms', value: 9 }]);
      });
    });
  });

  describe('Given a report with multiple groups', () => {
    describe('When toSnapshotEntries runs', () => {
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
        const result = toSnapshotEntries(report);

        // Assert
        expect(result).toEqual([
          { name: 'log:walk > tsgit', unit: 'ms', value: 1 },
          { name: 'log:walk > isomorphic-git', unit: 'ms', value: 2 },
          { name: 'status:clean > tsgit', unit: 'ms', value: 3 },
        ]);
      });
    });
  });

  describe('Given a group holding one valued benchmark and one carrying neither median nor mean', () => {
    describe('When toSnapshotEntries runs', () => {
      it('Then only the valued benchmark becomes an entry', () => {
        // Arrange
        const report: RawReport = {
          files: [
            {
              groups: [
                {
                  fullName: 'log:walk',
                  benchmarks: [{ name: 'tsgit', mean: 1, median: 1 }, { name: 'isomorphic-git' }],
                },
              ],
            },
          ],
        };

        // Act
        const result = toSnapshotEntries(report);

        // Assert
        expect(result).toEqual([{ name: 'log:walk > tsgit', unit: 'ms', value: 1 }]);
      });
    });
  });
});

describe('assertEveryBenchmarkValued', () => {
  describe('Given a report whose only benchmark carries neither median nor mean', () => {
    describe('When the guard runs', () => {
      it('Then it throws naming that benchmark', () => {
        // Arrange
        const report: RawReport = {
          files: [{ groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit' }] }] }],
        };

        // Act
        let thrown: unknown;
        try {
          assertEveryBenchmarkValued(report);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('log:walk > tsgit');
      });
    });
  });

  describe('Given a report with two benchmarks carrying neither median nor mean', () => {
    describe('When the guard runs', () => {
      it('Then the message names both keys', () => {
        // Arrange
        const report: RawReport = {
          files: [
            { groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit' }] }] },
            { groups: [{ fullName: 'status:clean', benchmarks: [{ name: 'isomorphic-git' }] }] },
          ],
        };

        // Act
        let thrown: unknown;
        try {
          assertEveryBenchmarkValued(report);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('log:walk > tsgit');
        expect((thrown as Error).message).toContain('status:clean > isomorphic-git');
      });
    });
  });

  describe('Given a benchmark with a mean and no median', () => {
    describe('When the guard runs', () => {
      it('Then it returns the report unchanged', () => {
        // Arrange
        const report: RawReport = {
          files: [{ groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit', mean: 9 }] }] }],
        };

        // Act
        const result = assertEveryBenchmarkValued(report);

        // Assert
        expect(result).toBe(report);
      });
    });
  });

  describe('Given a benchmark with a median and no mean', () => {
    describe('When the guard runs', () => {
      it('Then it returns the report unchanged', () => {
        // Arrange
        const report: RawReport = {
          files: [
            { groups: [{ fullName: 'log:walk', benchmarks: [{ name: 'tsgit', median: 4 }] }] },
          ],
        };

        // Act
        const result = assertEveryBenchmarkValued(report);

        // Assert
        expect(result).toBe(report);
      });
    });
  });

  describe('Given a report with no files', () => {
    describe('When the guard runs', () => {
      it('Then it returns the report unchanged', () => {
        // Arrange
        const report: RawReport = { files: [] };

        // Act
        const result = assertEveryBenchmarkValued(report);

        // Assert
        expect(result).toBe(report);
      });
    });
  });
});

describe('withNodeVersion', () => {
  describe('Given a resolved version and an empty entry list', () => {
    describe('When withNodeVersion runs', () => {
      it('Then it returns an empty array', () => {
        // Arrange
        const sut = withNodeVersion;

        // Act
        const result = sut([], '24.19.0');

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given several entries from a multi-group, multi-benchmark report', () => {
    describe('When withNodeVersion stamps them', () => {
      it('Then every entry carries the resolved version in extra, with its other fields unchanged', () => {
        // Arrange
        const entries = toSnapshotEntries({
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
        });
        const sut = withNodeVersion;

        // Act
        const result = sut(entries, '24.19.0');

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

  describe('Given a resolved-version env var containing a wildcard but no slash', () => {
    describe('When resolveNodeVersion runs', () => {
      it('Then it refuses, naming the offending value', () => {
        // Arrange — `lts/*` trips BOTH the slash and the wildcard condition,
        // so it cannot prove either alone. This value trips only the
        // wildcard, which is what pins that half of the guard.
        const env = { RESOLVED_NODE_VERSION: '24.*' };

        // Act
        let thrown: unknown;
        try {
          resolveNodeVersion(env);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('24.*');
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

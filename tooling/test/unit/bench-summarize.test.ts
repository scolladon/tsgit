import { describe, expect, it } from 'vitest';

import {
  type BenchGroup,
  type RawReport,
  renderRow,
  renderSummary,
  type SummaryEnvironment,
} from '../../bench-summarize.js';

describe('renderRow', () => {
  describe('Given a group with a measured tsgit entry and a measured isomorphic-git entry', () => {
    describe('When renderRow renders it', () => {
      it('Then the row carries both cells and the speedup', () => {
        // Arrange
        const group: BenchGroup = {
          fullName:
            'Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git',
          benchmarks: [
            { name: 'tsgit', median: 3.698, hz: 256, rme: 5.26 },
            { name: 'isomorphic-git', median: 1.233, hz: 529, rme: 13.78 },
          ],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git | 3.698 ms (256/s, ±5.26%) | 1.233 ms (529/s, ±13.78%) | 0.33× |',
        );
      });
    });
  });

  describe('Given a group with a measured tsgit entry and no isomorphic-git entry', () => {
    describe('When renderRow renders it', () => {
      it('Then the tsgit cell renders as in a paired row, the baseline cell is an em dash and the speedup is n/a', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'inflate a 64 KiB zlib member',
          benchmarks: [{ name: 'tsgit', median: 0.512, hz: 1953, rme: 2.1 }],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | 0.512 ms (1953/s, ±2.10%) | — | n/a |',
        );
      });
    });
  });

  describe('Given a group holding only an isomorphic-git entry', () => {
    describe('When renderRow renders it', () => {
      it('Then both cells render as missing', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'inflate a 64 KiB zlib member',
          benchmarks: [{ name: 'isomorphic-git', median: 0.9, hz: 1111, rme: 3.4 }],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | _missing entry_ | _missing entry_ | n/a |',
        );
      });
    });
  });

  describe('Given a group with an empty benchmark list', () => {
    describe('When renderRow renders it', () => {
      it('Then both cells render as missing', () => {
        // Arrange
        const group: BenchGroup = { fullName: 'inflate a 64 KiB zlib member', benchmarks: [] };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | _missing entry_ | _missing entry_ | n/a |',
        );
      });
    });
  });

  describe('Given a tsgit entry with a mean and no median', () => {
    describe('When renderRow renders it', () => {
      it('Then the cell is built from the mean', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'inflate a 64 KiB zlib member',
          benchmarks: [{ name: 'tsgit', mean: 0.75, hz: 1333, rme: 1.5 }],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | 0.750 ms (1333/s, ±1.50%) | — | n/a |',
        );
      });
    });
  });

  describe('Given a tsgit-only group whose entry carries neither median nor mean nor hz', () => {
    describe('When renderRow renders it', () => {
      it('Then both cells render as missing and nothing throws', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'a scenario that threw during warmup',
          benchmarks: [{ name: 'tsgit', rme: 0 }],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| a scenario that threw during warmup | _missing entry_ | _missing entry_ | n/a |',
        );
      });
    });
  });

  describe('Given a tsgit entry with a median and no hz', () => {
    describe('When renderRow renders it', () => {
      it('Then both cells render as missing', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'inflate a 64 KiB zlib member',
          benchmarks: [{ name: 'tsgit', median: 0.5, rme: 1.5 }],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | _missing entry_ | _missing entry_ | n/a |',
        );
      });
    });
  });

  describe('Given a tsgit entry with an hz and neither median nor mean', () => {
    describe('When renderRow renders it', () => {
      it('Then both cells render as missing', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'inflate a 64 KiB zlib member',
          benchmarks: [{ name: 'tsgit', hz: 1953, rme: 2.1 }],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | _missing entry_ | _missing entry_ | n/a |',
        );
      });
    });
  });

  describe('Given a group whose tsgit entry is measured and whose isomorphic-git entry is not', () => {
    describe('When renderRow renders it', () => {
      it('Then the row renders as a tsgit-only row', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'inflate a 64 KiB zlib member',
          benchmarks: [
            { name: 'tsgit', median: 0.512, hz: 1953, rme: 2.1 },
            { name: 'isomorphic-git', rme: 0 },
          ],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| inflate a 64 KiB zlib member | 0.512 ms (1953/s, ±2.10%) | — | n/a |',
        );
      });
    });
  });

  describe('Given a paired group whose tsgit value is zero', () => {
    describe('When renderRow renders it', () => {
      it('Then the speedup reads n/a', () => {
        // Arrange
        const group: BenchGroup = {
          fullName: 'a scenario tsgit runs instantaneously',
          benchmarks: [
            { name: 'tsgit', median: 0, hz: 500000, rme: 0.01 },
            { name: 'isomorphic-git', median: 1.5, hz: 667, rme: 4.2 },
          ],
        };
        const sut = renderRow;

        // Act
        const result = sut(group);

        // Assert
        expect(result).toBe(
          '| a scenario tsgit runs instantaneously | 0.000 ms (500000/s, ±0.01%) | 1.500 ms (667/s, ±4.20%) | n/a |',
        );
      });
    });
  });
});

describe('renderSummary', () => {
  describe('Given a report with one paired group and one tsgit-only group and a fixed environment', () => {
    describe('When renderSummary builds the document', () => {
      it('Then the document carries the header, the table header, one row per group in file-then-group order, and the footnote', () => {
        // Arrange
        const raw: RawReport = {
          files: [
            {
              filepath: 'test/bench/example.bench.ts',
              groups: [
                {
                  fullName: 'first scenario',
                  benchmarks: [
                    { name: 'tsgit', median: 3.698, hz: 256, rme: 5.26 },
                    { name: 'isomorphic-git', median: 1.233, hz: 529, rme: 13.78 },
                  ],
                },
                {
                  fullName: 'second scenario',
                  benchmarks: [{ name: 'tsgit', median: 0.512, hz: 1953, rme: 2.1 }],
                },
              ],
            },
          ],
        };
        const environment: SummaryEnvironment = {
          generatedAt: '2026-09-05T00:00:00.000Z',
          platform: 'darwin',
          arch: 'arm64',
          nodeVersion: 'v24.19.0',
          cpuModel: 'Apple M4',
        };
        const sut = renderSummary;

        // Act
        const result = sut(raw, environment);

        // Assert
        expect(result).toBe(
          [
            '# Benchmark results',
            '',
            'Generated 2026-09-05T00:00:00.000Z on `darwin-arm64` (Node v24.19.0, Apple M4).',
            '',
            '| Scenario | tsgit | isomorphic-git | speedup (tsgit faster) |',
            '|---|---|---|---|',
            '| first scenario | 3.698 ms (256/s, ±5.26%) | 1.233 ms (529/s, ±13.78%) | 0.33× |',
            '| second scenario | 0.512 ms (1953/s, ±2.10%) | — | n/a |',
            '',
            '> _speedup > 1×_ means tsgit beat isomorphic-git on median runtime. Raw',
            '> data in `reports/benchmarks/raw.json` includes p75/p99/RME and per-run',
            '> sample counts. GitHub Actions runners introduce ±20% variance — trust',
            '> direction more than absolute numbers. The speedup column applies to',
            '> paired rows only.',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a report with two files, each holding one group, and a fixed environment', () => {
    describe('When renderSummary builds the document', () => {
      it('Then both rows appear, the first file’s group before the second’s', () => {
        // Arrange
        const raw: RawReport = {
          files: [
            {
              filepath: 'test/bench/a.bench.ts',
              groups: [
                {
                  fullName: 'from file a',
                  benchmarks: [{ name: 'tsgit', median: 1, hz: 1000, rme: 1 }],
                },
              ],
            },
            {
              filepath: 'test/bench/b.bench.ts',
              groups: [
                {
                  fullName: 'from file b',
                  benchmarks: [{ name: 'tsgit', median: 2, hz: 500, rme: 2 }],
                },
              ],
            },
          ],
        };
        const environment: SummaryEnvironment = {
          generatedAt: '2026-09-05T00:00:00.000Z',
          platform: 'darwin',
          arch: 'arm64',
          nodeVersion: 'v24.19.0',
          cpuModel: 'Apple M4',
        };
        const sut = renderSummary;

        // Act
        const result = sut(raw, environment);

        // Assert
        expect(result).toBe(
          [
            '# Benchmark results',
            '',
            'Generated 2026-09-05T00:00:00.000Z on `darwin-arm64` (Node v24.19.0, Apple M4).',
            '',
            '| Scenario | tsgit | isomorphic-git | speedup (tsgit faster) |',
            '|---|---|---|---|',
            '| from file a | 1.000 ms (1000/s, ±1.00%) | — | n/a |',
            '| from file b | 2.000 ms (500/s, ±2.00%) | — | n/a |',
            '',
            '> _speedup > 1×_ means tsgit beat isomorphic-git on median runtime. Raw',
            '> data in `reports/benchmarks/raw.json` includes p75/p99/RME and per-run',
            '> sample counts. GitHub Actions runners introduce ±20% variance — trust',
            '> direction more than absolute numbers. The speedup column applies to',
            '> paired rows only.',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a report with no files and a fixed environment', () => {
    describe('When renderSummary builds the document', () => {
      it('Then the document carries the header and the footnote and no rows', () => {
        // Arrange
        const raw: RawReport = { files: [] };
        const environment: SummaryEnvironment = {
          generatedAt: '2026-09-05T00:00:00.000Z',
          platform: 'darwin',
          arch: 'arm64',
          nodeVersion: 'v24.19.0',
          cpuModel: 'Apple M4',
        };
        const sut = renderSummary;

        // Act
        const result = sut(raw, environment);

        // Assert
        expect(result).toBe(
          [
            '# Benchmark results',
            '',
            'Generated 2026-09-05T00:00:00.000Z on `darwin-arm64` (Node v24.19.0, Apple M4).',
            '',
            '| Scenario | tsgit | isomorphic-git | speedup (tsgit faster) |',
            '|---|---|---|---|',
            '',
            '> _speedup > 1×_ means tsgit beat isomorphic-git on median runtime. Raw',
            '> data in `reports/benchmarks/raw.json` includes p75/p99/RME and per-run',
            '> sample counts. GitHub Actions runners introduce ±20% variance — trust',
            '> direction more than absolute numbers. The speedup column applies to',
            '> paired rows only.',
            '',
          ].join('\n'),
        );
      });
    });
  });
});

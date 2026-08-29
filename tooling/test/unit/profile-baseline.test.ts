import { describe, expect, it } from 'vitest';

import type { Baseline } from '../../profile-baseline.js';
import { renderBaselineJson, renderBaselineMarkdown } from '../../profile-baseline.js';

describe('renderBaselineJson', () => {
  describe('Given a baseline with a read command carrying hotShares', () => {
    describe('When renderBaselineJson runs', () => {
      it('Then the JSON parses back to the whole baseline (banner included) and ends in a newline', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            log: {
              hotShares: [{ frame: 'walkCommitsByDate', self: 0.41, ticks: 820 }],
              totalTicks: 2000,
              underSampled: false,
            },
          },
        };

        // Act
        const result = renderBaselineJson(baseline);

        // Assert — the whole object round-trips (a dropped `generatedOn` mutant
        // survives an assertion on `.commands` alone), and the trailing newline
        // is present (a POSIX-friendly file, pinned against a dropped `+ '\n'`).
        expect(JSON.parse(result)).toEqual(baseline);
        expect(result.endsWith('\n')).toBe(true);
      });
    });
  });
});

describe('renderBaselineMarkdown', () => {
  describe('Given a write command with hotShares and setupShares', () => {
    describe('When renderBaselineMarkdown runs', () => {
      it('Then the markdown contains a hotShares table row for each command frame AND a setupShares table row for each setup frame', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            commit: {
              hotShares: [{ frame: 'writeCommitObject', self: 0.75, ticks: 750 }],
              setupShares: [{ frame: 'bootstrapRepository', self: 0.25, ticks: 250 }],
              totalTicks: 1000,
              underSampled: false,
            },
          },
        };

        // Act
        const result = renderBaselineMarkdown(baseline);

        // Assert
        expect(result).toContain('writeCommitObject');
        expect(result).toContain('0.75');
        expect(result).toContain('bootstrapRepository');
        expect(result).toContain('0.25');
      });
    });
  });

  describe('Given a read command with no setupShares', () => {
    describe('When renderBaselineMarkdown runs', () => {
      it('Then no setupShares table is emitted for it', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            log: {
              hotShares: [{ frame: 'walkCommitsByDate', self: 0.41, ticks: 820 }],
              totalTicks: 2000,
              underSampled: false,
            },
          },
        };

        // Act
        const result = renderBaselineMarkdown(baseline);

        // Assert
        expect(result).not.toContain('setupShares');
      });
    });
  });

  describe('Given a command baseline below the tick floor', () => {
    describe('When renderBaselineMarkdown runs', () => {
      it('Then the markdown marks it under-sampled', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            show: {
              hotShares: [{ frame: 'readCommit', self: 1, ticks: 2 }],
              totalTicks: 2,
              underSampled: true,
            },
          },
        };

        // Act
        const result = renderBaselineMarkdown(baseline);

        // Assert
        expect(result).toContain('under-sampled');
      });
    });
  });

  describe('Given a command baseline at or above the tick floor', () => {
    describe('When renderBaselineMarkdown runs', () => {
      it('Then the markdown does not mark it under-sampled', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            log: {
              hotShares: [{ frame: 'walkCommitsByDate', self: 1, ticks: 2000 }],
              totalTicks: 2000,
              underSampled: false,
            },
          },
        };

        // Act
        const result = renderBaselineMarkdown(baseline);

        // Assert
        expect(result).not.toContain('under-sampled');
      });
    });
  });

  describe('Given a command baseline with a totalTicks value', () => {
    describe('When renderBaselineMarkdown runs', () => {
      it('Then the markdown carries a totalTicks line for that command', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            log: {
              hotShares: [{ frame: 'walkCommitsByDate', self: 1, ticks: 2000 }],
              totalTicks: 2000,
              underSampled: false,
            },
          },
        };

        // Act
        const result = renderBaselineMarkdown(baseline);

        // Assert
        expect(result).toContain('totalTicks: 2000');
      });
    });
  });
});

describe('renderBaselineJson', () => {
  describe('Given a command baseline with totalTicks and underSampled', () => {
    describe('When renderBaselineJson runs', () => {
      it('Then the JSON carries totalTicks and underSampled for that command', () => {
        // Arrange
        const baseline: Baseline = {
          generatedOn: 'darwin-arm64 / node v20.0.0 / Apple M1',
          commands: {
            show: {
              hotShares: [{ frame: 'readCommit', self: 1, ticks: 2 }],
              totalTicks: 2,
              underSampled: true,
            },
          },
        };

        // Act
        const result = renderBaselineJson(baseline);
        const parsed = JSON.parse(result) as Baseline;

        // Assert
        expect(parsed.commands.show?.totalTicks).toBe(2);
        expect(parsed.commands.show?.underSampled).toBe(true);
      });
    });
  });
});

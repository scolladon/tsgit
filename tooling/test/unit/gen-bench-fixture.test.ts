import { describe, expect, it } from 'vitest';

import {
  DELTA_CHAIN_FIXTURE,
  LARGE_FIXTURE,
  MANY_PACK_FIXTURE,
  MEDIUM_FIXTURE,
} from '../../../test/bench/support/fixture-generator.ts';
import { formatPruneReport, selectFixtureAction } from '../../gen-bench-fixture.ts';

describe('Given an argv token naming one of the four fixture labels', () => {
  describe('When selectFixtureAction routes it', () => {
    it.each([
      ['medium', MEDIUM_FIXTURE],
      ['large', LARGE_FIXTURE],
      ['delta-chain', DELTA_CHAIN_FIXTURE],
      ['many-pack', MANY_PACK_FIXTURE],
    ] as const)('Then %s routes to a generate action for that spec', (label, spec) => {
      // Arrange
      const sut = selectFixtureAction;

      // Act
      const result = sut(label);

      // Assert
      expect(result).toEqual({ kind: 'generate', spec });
    });
  });
});

describe('Given a prune flag, an unknown token, or no token at all', () => {
  describe('When selectFixtureAction routes it', () => {
    it.each([
      ['--prune', 'prune'],
      ['bogus-token', 'usage'],
      [undefined, 'usage'],
    ] as const)('Then %s routes to kind %s', (label, kind) => {
      // Arrange
      const sut = selectFixtureAction;

      // Act
      const result = sut(label);

      // Assert
      expect(result.kind).toBe(kind);
    });
  });
});

describe('formatPruneReport', () => {
  const root = '/cache/tsgit-bench';

  describe('Given a report that removed nothing and failed nothing', () => {
    describe('When formatPruneReport renders it', () => {
      it('Then it says there was nothing to prune and exits 0', () => {
        // Arrange
        const sut = formatPruneReport;

        // Act
        const result = sut({ root, removed: [], failed: [] });

        // Assert
        expect(result).toEqual({
          stdout: `nothing to prune under ${root}\n`,
          stderr: '',
          exitCode: 0,
        });
      });
    });
  });

  describe('Given a report that removed two directories', () => {
    describe('When formatPruneReport renders it', () => {
      it('Then it lists each removal, sums logical bytes, and exits 0', () => {
        // Arrange
        const sut = formatPruneReport;

        // Act
        const result = sut({
          root,
          removed: [
            { path: `${root}/medium-v1`, bytes: 100 },
            { path: `${root}/small-v2`, bytes: 7 },
          ],
          failed: [],
        });

        // Assert
        expect(result.stdout).toBe(
          `removed ${root}/medium-v1 (100 bytes)\n` +
            `removed ${root}/small-v2 (7 bytes)\n` +
            `reclaimed 107 logical bytes from 2 directories under ${root}\n`,
        );
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      });
    });
  });

  describe('Given a report with one removal and one failure', () => {
    describe('When formatPruneReport renders it', () => {
      it('Then the failure goes to stderr with its reason and the exit code is 1', () => {
        // Arrange
        const sut = formatPruneReport;

        // Act
        const result = sut({
          root,
          removed: [{ path: `${root}/small-v2`, bytes: 7 }],
          failed: [{ path: `${root}/large-v1`, reason: 'permission denied' }],
        });

        // Assert
        expect(result.stdout).toBe(
          `removed ${root}/small-v2 (7 bytes)\n` +
            `reclaimed 7 logical bytes from 1 directories under ${root}\n`,
        );
        expect(result.stderr).toBe(`could not remove ${root}/large-v1: permission denied\n`);
        expect(result.exitCode).toBe(1);
      });
    });
  });
});

/**
 * Property tests for `portablePosixPolicy`: the hand-rolled, dependency-free
 * stand-in must agree with the independently tested `node:path/posix` oracle
 * over the absolute-POSIX-path subset it claims (segments including `.`,
 * `..` and duplicate slashes), and stay total over that grammar.
 */
import * as nodePosix from 'node:path/posix';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { portablePosixPolicy } from '../../../src/repository/portable-posix-policy.js';
import { arbSegment } from './arbitraries.js';

const ORACLE_NUM_RUNS = 100;

/** Segments drawn from name chars plus the special `.`/`..`/empty forms. */
function arbMessySegment(): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 4, arbitrary: arbSegment() },
    { weight: 1, arbitrary: fc.constant('.') },
    { weight: 1, arbitrary: fc.constant('..') },
    { weight: 1, arbitrary: fc.constant('') },
  );
}

function arbAbsoluteMessyPath(): fc.Arbitrary<string> {
  return fc
    .array(arbMessySegment(), { minLength: 0, maxLength: 8 })
    .map((segments) => `/${segments.join('/')}`);
}

describe('portablePosixPolicy properties', () => {
  describe('Given an arbitrary absolute POSIX path with messy segments', () => {
    describe('When resolve runs', () => {
      it('Then it agrees with node:path/posix.resolve', () => {
        // Arrange
        const sut = portablePosixPolicy.resolve;

        // Act & Assert
        fc.assert(
          fc.property(arbAbsoluteMessyPath(), (path) => {
            expect(sut(path)).toBe(nodePosix.resolve(path));
          }),
          { numRuns: ORACLE_NUM_RUNS },
        );
      });
    });

    describe('When dirname runs', () => {
      it('Then it agrees with node:path/posix.dirname of the normalized path', () => {
        // Arrange
        const sut = portablePosixPolicy.dirname;

        // Act & Assert
        fc.assert(
          fc.property(arbAbsoluteMessyPath(), (path) => {
            expect(sut(path)).toBe(nodePosix.dirname(nodePosix.resolve(path)));
          }),
          { numRuns: ORACLE_NUM_RUNS },
        );
      });
    });

    describe('When basename runs', () => {
      it('Then it agrees with node:path/posix.basename of the normalized path', () => {
        // Arrange
        const sut = portablePosixPolicy.basename;

        // Act & Assert
        fc.assert(
          fc.property(arbAbsoluteMessyPath(), (path) => {
            expect(sut(path)).toBe(nodePosix.basename(nodePosix.resolve(path)));
          }),
          { numRuns: ORACLE_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary absolute base and a relative tail', () => {
    describe('When join runs', () => {
      it('Then it agrees with node:path/posix normalization of the joined form', () => {
        // Arrange
        const sut = portablePosixPolicy.join;

        // Act & Assert
        fc.assert(
          fc.property(
            arbAbsoluteMessyPath(),
            fc.array(arbSegment(), { minLength: 1, maxLength: 4 }),
            (base, tailSegments) => {
              const tail = tailSegments.join('/');
              expect(sut(base, tail)).toBe(nodePosix.resolve(nodePosix.join(base, tail)));
            },
          ),
          { numRuns: ORACLE_NUM_RUNS },
        );
      });
    });
  });
});

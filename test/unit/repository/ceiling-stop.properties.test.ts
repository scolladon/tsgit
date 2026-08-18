/**
 * Property tests for `longestStrictAncestor` — a compositional matcher that
 * reduces an array of ceiling entries to a single verdict (lens 2). The
 * example file pins the literal ceiling-table rows; these invariants prove
 * the aggregation holds beyond the enumerated entries.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { longestStrictAncestor } from '../../../src/repository/ceiling-stop.js';
import { arbSegment } from './arbitraries.js';

const COMPOSITION_NUM_RUNS = 100;

/** An absolute posix path of 1–6 name-safe segments. */
const arbAbsolutePath = (): fc.Arbitrary<string> =>
  fc
    .array(arbSegment(), { minLength: 1, maxLength: 6 })
    .map((segments) => `/${segments.join('/')}`);

/** A cwd plus the list of its strict ancestors (never the cwd itself). */
const arbCwdWithAncestors = (): fc.Arbitrary<{ cwd: string; ancestors: string[] }> =>
  fc.array(arbSegment(), { minLength: 2, maxLength: 6 }).map((segments) => {
    const cwd = `/${segments.join('/')}`;
    const ancestors = segments
      .slice(0, -1)
      .map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);
    return { cwd, ancestors };
  });

describe('longestStrictAncestor properties', () => {
  describe('Given an arbitrary cwd and no ceiling entries', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the identity verdict is undefined for both the absent and the empty input', () => {
        // Arrange
        const sut = longestStrictAncestor;

        // Act & Assert
        fc.assert(
          fc.property(arbAbsolutePath(), (cwd) => {
            expect(sut(undefined, cwd, posixPolicy)).toBeUndefined();
            expect(sut([], cwd, posixPolicy)).toBeUndefined();
          }),
          { numRuns: COMPOSITION_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary ceiling list and an appended non-ancestor entry', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the appended entry never changes the verdict', () => {
        // Arrange
        const sut = longestStrictAncestor;

        // Act & Assert
        fc.assert(
          fc.property(
            arbCwdWithAncestors(),
            fc.array(arbAbsolutePath(), { maxLength: 4 }),
            arbSegment(),
            ({ cwd, ancestors }, entries, foreign) => {
              const baseline = sut([...entries, ...ancestors], cwd, posixPolicy);
              // A sibling under cwd is never a strict ancestor of it.
              const nonAncestor = `${cwd}-${foreign}`;
              const result = sut([...entries, ...ancestors, nonAncestor], cwd, posixPolicy);
              expect(result).toBe(baseline);
            },
          ),
          { numRuns: COMPOSITION_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary ceiling list in an arbitrary order', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the verdict is invariant under permutation of the entries', () => {
        // Arrange
        const sut = longestStrictAncestor;

        // Act & Assert
        fc.assert(
          fc.property(
            arbCwdWithAncestors(),
            fc.array(arbAbsolutePath(), { maxLength: 4 }),
            ({ cwd, ancestors }, entries) => {
              const forward = [...entries, ...ancestors];
              const reversed = [...forward].reverse();
              expect(sut(forward, cwd, posixPolicy)).toBe(sut(reversed, cwd, posixPolicy));
            },
          ),
          { numRuns: COMPOSITION_NUM_RUNS },
        );
      });
    });
  });

  describe('Given any ceiling list at all', () => {
    describe('When longestStrictAncestor runs', () => {
      it('Then the verdict is a strict ancestor of the cwd, or undefined', () => {
        // Arrange
        const sut = longestStrictAncestor;

        // Act & Assert
        fc.assert(
          fc.property(
            arbAbsolutePath(),
            fc.array(arbAbsolutePath(), { maxLength: 6 }),
            (cwd, entries) => {
              const result = sut(entries, cwd, posixPolicy);
              if (result === undefined) return;
              expect(result).not.toBe(cwd);
              expect(cwd.startsWith(result.endsWith('/') ? result : `${result}/`)).toBe(true);
            },
          ),
          { numRuns: COMPOSITION_NUM_RUNS },
        );
      });
    });
  });
});

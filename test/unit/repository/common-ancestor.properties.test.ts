/**
 * Property tests for `commonAncestor`: pins containment, single-element
 * identity, monotone depth, and append-a-descendant invariants across
 * arbitrary path families, on both `posixPolicy` and `windowsPolicy`.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { pathContains } from '../../../src/adapters/node/node-file-system.js';
import type { PathPolicy } from '../../../src/adapters/node/path-policy.js';
import { commonAncestor } from '../../../src/repository/common-ancestor.js';
import { arbRootedPolicy, arbSegment, buildPath } from './arbitraries.js';

const INVARIANT_NUM_RUNS = 100;

/** Segment count of `s` relative to its own volume root, for depth comparison. */
function depthOf(s: string, policy: PathPolicy): number {
  return s.slice(policy.rootOf(s).length).split(policy.sep).filter(Boolean).length;
}

describe('commonAncestor properties', () => {
  describe('Given a family of paths sharing a common head segment', () => {
    describe('When commonAncestor computes their ancestor', () => {
      it('Then the ancestor contains every input path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbRootedPolicy(),
            arbSegment(),
            fc.array(fc.array(arbSegment(), { minLength: 0, maxLength: 4 }), {
              minLength: 1,
              maxLength: 5,
            }),
            ({ policy, root }, head, extrasList) => {
              const inputs = extrasList.map((extras) => buildPath(policy, root, [head, ...extras]));

              const result = commonAncestor(inputs, policy);

              return inputs.every((p) => pathContains(result, policy.resolve(p), policy));
            },
          ),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });

  describe('Given a single absolute path', () => {
    describe('When commonAncestor computes its ancestor', () => {
      it('Then it returns the resolved path unchanged', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbRootedPolicy(),
            fc.array(arbSegment(), { minLength: 0, maxLength: 4 }),
            ({ policy, root }, segments) => {
              const p = buildPath(policy, root, segments);

              const result = commonAncestor([p], policy);

              return result === policy.resolve(p);
            },
          ),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });

  describe('Given a family of paths and an arbitrary same-root sibling', () => {
    describe('When the sibling is appended to the family', () => {
      it('Then the common ancestor never grows deeper', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbRootedPolicy(),
            fc.array(fc.array(arbSegment(), { minLength: 0, maxLength: 4 }), {
              minLength: 1,
              maxLength: 5,
            }),
            fc.array(arbSegment(), { minLength: 0, maxLength: 4 }),
            ({ policy, root }, segmentsList, siblingSegments) => {
              const inputs = segmentsList.map((segments) => buildPath(policy, root, segments));
              const sibling = buildPath(policy, root, siblingSegments);

              const before = commonAncestor(inputs, policy);
              const after = commonAncestor([...inputs, sibling], policy);

              return depthOf(after, policy) <= depthOf(before, policy);
            },
          ),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });

  describe('Given a family of paths sharing a common head segment and a strict descendant of their ancestor', () => {
    describe('When the descendant is appended to the family', () => {
      it('Then the common ancestor is unchanged', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbRootedPolicy(),
            arbSegment(),
            fc.array(fc.array(arbSegment(), { minLength: 0, maxLength: 4 }), {
              minLength: 1,
              maxLength: 5,
            }),
            fc.array(arbSegment(), { minLength: 1, maxLength: 4 }),
            ({ policy, root }, head, extrasList, extra) => {
              const inputs = extrasList.map((extras) => buildPath(policy, root, [head, ...extras]));
              const base = commonAncestor(inputs, policy);
              const descendant = base + policy.sep + extra.join(policy.sep);

              const result = commonAncestor([...inputs, descendant], policy);

              return result === base;
            },
          ),
          { numRuns: INVARIANT_NUM_RUNS },
        );
      });
    });
  });
});

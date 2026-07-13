/**
 * Property tests for the containment predicate: proves the B1/B2
 * precomputed-prefix comparison agrees with a from-scratch `pathContains`
 * (the independent oracle) across arbitrary root/child pairs, on both
 * `posixPolicy` and `windowsPolicy`.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  pathContains,
  pathContainsNormalized,
} from '../../../../src/adapters/node/node-file-system.js';
import {
  type PathPolicy,
  posixPolicy,
  windowsPolicy,
} from '../../../../src/adapters/node/path-policy.js';

const sut = pathContainsNormalized;

const ROUND_TRIP_NUM_RUNS = 200;

function arbSegmentChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 97, max: 122 }), // a-z
      fc.integer({ min: 65, max: 90 }), // A-Z
      fc.integer({ min: 48, max: 57 }), // 0-9
    )
    .map((code) => String.fromCharCode(code));
}

function arbSegment(): fc.Arbitrary<string> {
  return fc.string({ unit: arbSegmentChar(), minLength: 1, maxLength: 8 });
}

function arbPolicy(): fc.Arbitrary<PathPolicy> {
  return fc.constantFrom(posixPolicy, windowsPolicy);
}

/** Builds an absolute path from segments, joined with the policy separator. */
function buildPath(policy: PathPolicy, root: string, segments: ReadonlyArray<string>): string {
  return segments.reduce((acc, seg) => acc + policy.sep + seg, root);
}

/**
 * Local oracle mirroring the B1/B2 precomputed-prefix comparison:
 * `c === root || c.startsWith(rootWithSep)`, using a normalised child and
 * the root's `+sep` prefix — exactly what `isContainedInEitherRoot` now
 * does per root, but computed independently of the SUT.
 */
function precomputed(policy: PathPolicy, root: string, child: string): boolean {
  const normalizedRoot = policy.normalizeForCompare(root);
  const rootWithSep = normalizedRoot + policy.sep;
  const normalizedChild = policy.normalizeForCompare(child);
  return normalizedChild === normalizedRoot || normalizedChild.startsWith(rootWithSep);
}

describe('Given an arbitrary root and a child equal to the root', () => {
  describe('When compared via the precomputed-prefix oracle and pathContains', () => {
    it('Then both agree the child is contained', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbPolicy(), fc.constantFrom('/root', 'C:\\Root'), (policy, root) => {
          const precomputedResult = precomputed(policy, root, root);
          const oracleResult = pathContains(root, root, policy);

          return (
            precomputedResult === true &&
            oracleResult === true &&
            precomputedResult === oracleResult
          );
        }),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary root and a child strictly nested under it', () => {
  describe('When compared via the precomputed-prefix oracle and pathContains', () => {
    it('Then both agree the child is contained', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbPolicy(),
          fc.constantFrom('/root', 'C:\\Root'),
          fc.array(arbSegment(), { minLength: 1, maxLength: 4 }),
          (policy, root, segments) => {
            const child = buildPath(policy, root, segments);

            const precomputedResult = precomputed(policy, root, child);
            const oracleResult = pathContains(root, child, policy);

            return (
              precomputedResult === true &&
              oracleResult === true &&
              precomputedResult === oracleResult
            );
          },
        ),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary root and a prefix-only sibling (root + suffix, no separator)', () => {
  describe('When compared via the precomputed-prefix oracle and pathContains', () => {
    it('Then both agree the sibling is NOT contained', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbPolicy(),
          fc.constantFrom('/root', 'C:\\Root'),
          arbSegment(),
          (policy, root, suffix) => {
            const sibling = `${root}-${suffix}`;

            const precomputedResult = precomputed(policy, root, sibling);
            const oracleResult = pathContains(root, sibling, policy);

            return (
              precomputedResult === false &&
              oracleResult === false &&
              precomputedResult === oracleResult
            );
          },
        ),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary root and an arbitrary nested-or-sibling child', () => {
  describe('When invoking the precomputed-prefix predicate directly (sut) against pathContains', () => {
    it('Then sut agrees with pathContains for every generated pair', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbPolicy(),
          fc.constantFrom('/root', 'C:\\Root'),
          fc.array(arbSegment(), { minLength: 0, maxLength: 4 }),
          fc.boolean(),
          arbSegment(),
          (policy, root, segments, isSibling, suffix) => {
            const child = isSibling
              ? `${root}-${suffix}`
              : segments.length === 0
                ? root
                : buildPath(policy, root, segments);

            const normalizedRoot = policy.normalizeForCompare(root);
            const sutResult = sut(normalizedRoot, child, policy);
            const oracleResult = pathContains(root, child, policy);

            return sutResult === oracleResult;
          },
        ),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

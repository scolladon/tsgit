/**
 * Property tests for the containment predicate: pins `pathContains`'s
 * verdict against hard-coded expectations across arbitrary root/child
 * pairs, on both `posixPolicy` and `windowsPolicy`, plus the B3
 * join-algebra invariant.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { pathContains } from '../../../../src/adapters/node/node-file-system.js';
import {
  type PathPolicy,
  posixPolicy,
  windowsPolicy,
} from '../../../../src/adapters/node/path-policy.js';

const ROUND_TRIP_NUM_RUNS = 200;
const INVARIANT_NUM_RUNS = 100;

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

describe('Given an arbitrary root and a child equal to the root', () => {
  describe('When compared via pathContains', () => {
    it('Then the child is contained', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbPolicy(), fc.constantFrom('/root', 'C:\\Root'), (policy, root) => {
          const oracleResult = pathContains(root, root, policy);

          return oracleResult === true;
        }),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary root and a child strictly nested under it', () => {
  describe('When compared via pathContains', () => {
    it('Then the child is contained', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbPolicy(),
          fc.constantFrom('/root', 'C:\\Root'),
          fc.array(arbSegment(), { minLength: 1, maxLength: 4 }),
          (policy, root, segments) => {
            const child = buildPath(policy, root, segments);

            const oracleResult = pathContains(root, child, policy);

            return oracleResult === true;
          },
        ),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary root and a prefix-only sibling (root + suffix, no separator)', () => {
  describe('When compared via pathContains', () => {
    it('Then the sibling is NOT contained', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbPolicy(),
          fc.constantFrom('/root', 'C:\\Root'),
          arbSegment(),
          (policy, root, suffix) => {
            const sibling = `${root}-${suffix}`;

            const oracleResult = pathContains(root, sibling, policy);

            return oracleResult === false;
          },
        ),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

/**
 * B3 join-algebra: proves `contained(join(realParent, basename)) ===
 * contained(realParent)` for a single clean `basename` (no separator, no
 * `.`/`..` — guaranteed by `arbSegment`'s alphanumeric-only charset), the
 * exact equivalence B3 relies on to memoise the lstat-arm post-check once
 * per parent instead of once per entry. `contained` is a local dual-root
 * oracle (`pathContains` against BOTH root and canon), independent of the
 * SUT's private `isContainedInEitherRoot`.
 */
function dualRootContained(
  policy: PathPolicy,
  root: string,
  canonicalRoot: string,
  candidate: string,
): boolean {
  return pathContains(root, candidate, policy) || pathContains(canonicalRoot, candidate, policy);
}

describe('Given an arbitrary realParent (contained or not) and an arbitrary single clean basename', () => {
  describe('When comparing containment of the joined leaf against containment of the bare realParent', () => {
    it('Then both agree (the B3 per-parent memoisation is verdict-identical)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbPolicy(),
          fc.constantFrom('/root', 'C:\\Root'),
          fc.constantFrom('/canon', 'C:\\Canon'),
          fc.array(arbSegment(), { minLength: 0, maxLength: 4 }),
          fc.boolean(),
          arbSegment(),
          arbSegment(),
          (policy, root, canonicalRoot, segments, useCanonical, siblingSuffix, basename) => {
            const base = useCanonical ? canonicalRoot : root;
            const realParent = segments.length === 0 ? base : buildPath(policy, base, segments);
            // Half the time exercise a realParent that is NOT contained (a
            // sibling of BOTH roots) — the security-critical branch (parent
            // symlinks OUT → realParent not contained → cached false).
            const candidateParent =
              siblingSuffix.length % 2 === 0 ? realParent : `${root}-${siblingSuffix}-outside`;
            const joined = `${candidateParent}${policy.sep}${basename}`;

            const parentVerdict = dualRootContained(policy, root, canonicalRoot, candidateParent);
            const joinedVerdict = dualRootContained(policy, root, canonicalRoot, joined);

            return joinedVerdict === parentVerdict;
          },
        ),
        { numRuns: INVARIANT_NUM_RUNS },
      );
    });
  });
});

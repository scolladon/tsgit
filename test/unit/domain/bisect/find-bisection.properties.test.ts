import fc from 'fast-check';
import { assert, describe, expect, it } from 'vitest';
import type { BisectCandidate } from '../../../../src/domain/bisect/bisect.js';
import { findBisection } from '../../../../src/domain/bisect/bisect.js';
import { estimateSteps } from '../../../../src/domain/bisect/estimate-steps.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { arbAll, arbCandidateDag } from './arbitraries.js';

/**
 * Independent DFS weight oracle — mirrors `countDistance` but defined here so
 * the property test does not use the production function as its own oracle.
 */
const reachableCount = (
  startId: ObjectId,
  byId: ReadonlyMap<ObjectId, BisectCandidate>,
): number => {
  const visited = new Set<ObjectId>();
  const stack: ObjectId[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop() as ObjectId;
    if (visited.has(id)) continue;
    const c = byId.get(id);
    if (c === undefined) continue;
    visited.add(id);
    for (const p of c.parents) {
      if (!visited.has(p)) stack.push(p);
    }
  }
  return visited.size;
};

describe('estimateSteps — property: monotonic non-decreasing', () => {
  describe('Given two arbitrary non-negative integers a ≤ b, When estimating steps', () => {
    it('Then estimateSteps(a) ≤ estimateSteps(b)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc
            .tuple(arbAll, arbAll)
            .map(([x, y]) => (x <= y ? ([x, y] as const) : ([y, x] as const))),
          ([a, b]) => {
            expect(estimateSteps(a)).toBeLessThanOrEqual(estimateSteps(b));
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe('findBisection — properties over arbitrary candidate DAGs', () => {
  describe('Given an arbitrary non-empty candidate DAG, When finding bisection', () => {
    it('Then result is always a member of the input candidate set', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCandidateDag, (candidates) => {
          const sut = findBisection;

          // Act
          const result = sut(candidates);

          // Assert
          assert(result !== undefined, 'non-empty input must yield a result');
          const ids = new Set(candidates.map((c) => c.id));
          expect(ids.has(result.nextCommit)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('Then it never throws on any non-empty acyclic DAG', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCandidateDag, (candidates) => {
          const sut = findBisection;
          expect(() => sut(candidates)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('Then 1 ≤ reaches ≤ candidateCount', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCandidateDag, (candidates) => {
          const sut = findBisection;

          // Act
          const result = sut(candidates);

          // Assert
          assert(result !== undefined, 'non-empty input must yield a result');
          expect(result.reaches).toBeGreaterThanOrEqual(1);
          expect(result.reaches).toBeLessThanOrEqual(result.candidateCount);
        }),
        { numRuns: 100 },
      );
    });

    it('Then candidateCount equals the input length', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCandidateDag, (candidates) => {
          const sut = findBisection;

          // Act
          const result = sut(candidates);

          // Assert
          assert(result !== undefined, 'non-empty input must yield a result');
          expect(result.candidateCount).toBe(candidates.length);
        }),
        { numRuns: 100 },
      );
    });

    it('Then no candidate has a higher distance than the chosen midpoint', () => {
      // Arrange — distance = min(weight, all-weight); weight = reachable count from candidate.
      fc.assert(
        fc.property(arbCandidateDag, (candidates) => {
          const sut = findBisection;
          const all = candidates.length;

          // Act
          const result = sut(candidates);
          assert(result !== undefined, 'non-empty input must yield a result');

          // Assert — compute each candidate's distance independently (oracle: reachableCount)
          const byId = new Map<ObjectId, BisectCandidate>(candidates.map((c) => [c.id, c]));
          const midDist = Math.min(result.reaches, all - result.reaches);
          for (const c of candidates) {
            const w = reachableCount(c.id, byId);
            const d = Math.min(w, all - w);
            expect(d).toBeLessThanOrEqual(midDist);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Given an empty candidate list, When finding bisection', () => {
    it('Then it returns undefined (total function over empty input)', () => {
      // Arrange + Act + Assert
      const sut = findBisection;
      expect(sut([])).toBeUndefined();
    });
  });
});

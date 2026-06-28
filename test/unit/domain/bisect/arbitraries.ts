import fc from 'fast-check';
import type { BisectCandidate } from '../../../../src/domain/bisect/types.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

/**
 * Generates a small, acyclic candidate DAG where each commit's in-set parents
 * are a subset of strictly-older commits (guaranteed acyclic by construction).
 *
 * Each generated array is in oldest-first order.
 */
export const arbCandidateDag = fc.integer({ min: 1, max: 12 }).chain((size) =>
  fc
    .array(fc.array(fc.boolean(), { minLength: 0, maxLength: size }), {
      minLength: size,
      maxLength: size,
    })
    .map((parentMasks): ReadonlyArray<BisectCandidate> => {
      return parentMasks.map((mask, i) => {
        const parents: ObjectId[] = [];
        for (let j = 0; j < i; j++) {
          if (mask[j] === true) {
            parents.push(`${j}`.padStart(40, '0') as ObjectId);
          }
        }
        return {
          id: `${i}`.padStart(40, '0') as ObjectId,
          parents,
          date: i,
        };
      });
    }),
);

/**
 * Generates arbitrary non-negative integers for the `estimateSteps` property.
 * The property is defined over all non-negative integers, but practical git
 * repositories have far fewer than 2^31 commits.
 */
export const arbAll = fc.integer({ min: 0, max: 10_000 });

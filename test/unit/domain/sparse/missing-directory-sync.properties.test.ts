import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { presentPaths, presentPathsSync } from '../../../../src/domain/sparse/missing-directory.js';

const NUM_RUNS = 200;
const SLASH = '/';
const arbSegment = fc.stringMatching(/^[abc]{1,2}$/);
const arbPath = fc
  .array(arbSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join(SLASH));
const arbPaths = fc.uniqueArray(arbPath, { maxLength: 12 }).map((paths) => [...paths].sort());
const arbAnswers = fc.uniqueArray(arbPath, { maxLength: 30 });

/** An arbitrary answer table, not a coherent tree: the twins must agree even on inconsistent probes. */
const answerFrom = (yes: ReadonlySet<string>) => (path: string) => yes.has(path);

describe('presentPathsSync properties', () => {
  describe('Given arbitrary paths and an arbitrary probe', () => {
    describe('When walking them synchronously and asynchronously', () => {
      it('Then both return the same paths and ask the same probes in the same order', async () => {
        await fc.assert(
          fc.asyncProperty(arbPaths, arbAnswers, async (paths, yesList) => {
            // Arrange
            const yes = new Set([...yesList, ...yesList.map((p) => `${p}${SLASH}`)]);
            const answer = answerFrom(yes);
            const syncAsked: string[] = [];
            const asyncAsked: string[] = [];

            // Act
            const sut = presentPathsSync(paths, (p) => {
              syncAsked.push(p);
              return answer(p);
            });
            const expected = await presentPaths(paths, async (p) => {
              asyncAsked.push(p);
              return answer(p);
            });

            // Assert
            expect([...sut]).toEqual([...expected]);
            expect(syncAsked).toEqual(asyncAsked);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

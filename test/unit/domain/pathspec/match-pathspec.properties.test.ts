import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { matchesPathspec } from '../../../../src/domain/pathspec/match-pathspec.js';
import { arbCandidatePath, arbGlobPattern, arbLiteralPattern } from './arbitraries.js';

describe('match-pathspec properties', () => {
  describe('Given an arbitrary pathspec (mixed literal/glob, optional negations) and an arbitrary path', () => {
    describe('When matchesPathspec is called', () => {
      it('Then the verdict equals the last-matching entry rule (last-wins semantics)', () => {
        // Arrange + Act + Assert
        const arbPattern = fc
          .tuple(fc.boolean(), fc.oneof(arbLiteralPattern(), arbGlobPattern()))
          .map(([negate, body]) => (negate ? `!${body}` : body));
        const arbPatterns = fc.array(arbPattern, { minLength: 1, maxLength: 5 });
        fc.assert(
          fc.property(arbPatterns, arbCandidatePath(), (patterns, path) => {
            const spec = compilePathspec(patterns);

            // Compute the expected verdict by hand: iterate entries in order,
            // each match toggles the verdict by its negate flag. This mirrors
            // the production loop and validates the OR-aggregation shape.
            let expected = false;
            for (const entry of spec) {
              if (entry.compiled.test(path)) {
                expected = !entry.negated;
              }
            }

            const sut = matchesPathspec(spec, path);
            expect(sut).toBe(expected);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

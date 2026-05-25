import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FilePath } from '../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import { matchesPathspec } from '../../../../src/domain/pathspec/match-pathspec.js';
import { arbCandidatePath, arbGlobPattern, arbLiteralPattern } from './arbitraries.js';

const arbPlainPattern = fc.oneof(arbLiteralPattern(), arbGlobPattern());
const arbNegatedPattern = arbPlainPattern.map((body) => `!${body}`);

describe('match-pathspec properties', () => {
  describe('Given the empty spec and an arbitrary path', () => {
    describe('When matchesPathspec is called', () => {
      it('Then the verdict is always false', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCandidatePath(), (path) => {
            const sut = matchesPathspec(compilePathspec([]), path);
            expect(sut).toBe(false);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given a spec containing only negation patterns and an arbitrary path', () => {
    describe('When matchesPathspec is called', () => {
      it('Then the verdict is always false (starting state never flips to true)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbNegatedPattern, { minLength: 1, maxLength: 5 }),
            arbCandidatePath(),
            (negations, path) => {
              const sut = matchesPathspec(compilePathspec(negations), path);
              expect(sut).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a literal pattern L appended after an arbitrary spec', () => {
    describe('When matchesPathspec is called on the path L itself', () => {
      it('Then the verdict is true (the final non-negated literal match wins)', () => {
        // Arrange + Act + Assert
        // Appending a non-negated literal that matches the candidate path
        // is guaranteed by Git's last-wins semantics to set the verdict to
        // true regardless of what came before.
        fc.assert(
          fc.property(
            fc.array(arbPlainPattern, { minLength: 0, maxLength: 4 }),
            arbLiteralPattern(),
            (prefix, literal) => {
              const spec = compilePathspec([...prefix, literal]);
              const sut = matchesPathspec(spec, FilePath.from(literal));
              expect(sut).toBe(true);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a literal L followed by its negation appended after an arbitrary prefix', () => {
    describe('When matchesPathspec is called on the path L', () => {
      it('Then the verdict is false (the final negated match overrides earlier inclusions)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbPlainPattern, { minLength: 0, maxLength: 4 }),
            arbLiteralPattern(),
            (prefix, literal) => {
              const spec = compilePathspec([...prefix, literal, `!${literal}`]);
              const sut = matchesPathspec(spec, FilePath.from(literal));
              expect(sut).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

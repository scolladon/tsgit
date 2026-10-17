import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FilePath } from '../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';
import {
  matchesPathspec,
  matchesUnmergedPath,
  withoutExactly,
} from '../../../../src/domain/pathspec/match-pathspec.js';
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
            const result = matchesPathspec(compilePathspec([]), path);
            expect(result).toBe(false);
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
              const result = matchesPathspec(compilePathspec(negations), path);
              expect(result).toBe(false);
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
              const result = matchesPathspec(spec, FilePath.from(literal));
              expect(result).toBe(true);
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
              const result = matchesPathspec(spec, FilePath.from(literal));
              expect(result).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('matchesUnmergedPath properties', () => {
  const arbEntryCount = fc.integer({ min: 2, max: 5 });

  describe('Given a single index entry', () => {
    describe('When matchesUnmergedPath is called', () => {
      it('Then the verdict equals matchesPathspec', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbPlainPattern, { maxLength: 4 }),
            arbCandidatePath(),
            (patterns, path) => {
              const spec = compilePathspec(patterns);
              expect(matchesUnmergedPath(spec, path, 1)).toBe(matchesPathspec(spec, path));
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a spec that already selects the path', () => {
    describe('When matchesUnmergedPath is called with any entry count', () => {
      it('Then the verdict is true', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(arbPlainPattern, { maxLength: 4 }),
            arbCandidatePath(),
            fc.integer({ min: 1, max: 5 }),
            (patterns, path, count) => {
              const spec = compilePathspec([...patterns, path]);
              expect(matchesUnmergedPath(spec, path, count)).toBe(true);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a conflicted path and a trailing glob exclusion that matches it', () => {
    describe('When matchesUnmergedPath is called', () => {
      it('Then the verdict is false', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCandidatePath(), arbEntryCount, (path, count) => {
            const spec = compilePathspec(['', `!${path}*`]);
            expect(matchesUnmergedPath(spec, path, count)).toBe(false);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a conflicted path covered by dot and an exact exclusion', () => {
    describe('When matchesUnmergedPath is called', () => {
      it('Then the verdict stays true', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCandidatePath(), arbEntryCount, (path, count) => {
            const spec = compilePathspec(['', `!${path}`]);
            expect(matchesUnmergedPath(spec, path, count)).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('withoutExactly properties', () => {
  describe('Given an arbitrary spec and path', () => {
    describe('When the exact path is removed', () => {
      it('Then no exact literal stays and every other element stays in order', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.array(fc.oneof(arbPlainPattern, arbNegatedPattern), { maxLength: 5 }),
            arbCandidatePath(),
            (patterns, path) => {
              const spec = compilePathspec([...patterns, path, `!${path}`]);
              const result = withoutExactly(spec, path);
              expect(result.some((entry) => entry.isLiteral && entry.body === path)).toBe(false);
              expect(result).toEqual(
                spec.filter((entry) => !(entry.isLiteral && entry.body === path)),
              );
              expect(result.length).toBeLessThan(spec.length);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

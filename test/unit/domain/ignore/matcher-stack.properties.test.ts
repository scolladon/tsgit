import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { matches } from '../../../../src/domain/ignore/match.js';
import {
  type IgnoreLevel,
  matchInStack,
  matchInStackVerbose,
} from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import { FilePath } from '../../../../src/domain/objects/index.js';
import { arbCandidatePath, arbLiteralPattern } from '../pathspec/arbitraries.js';
import {
  arbExcludedDirectoryCase,
  arbLevelsBeyondDirectory,
  arbStackWithoutExcludedLeadingDirectory,
  judgeBeneathChain,
  levelOf,
} from './arbitraries.js';

const arbRuleLine = fc
  .tuple(fc.boolean(), arbLiteralPattern(), fc.boolean())
  .map(([negate, body, dirOnly]) => `${negate ? '!' : ''}${body}${dirOnly ? '/' : ''}`);

const arbRuleLines = fc.array(arbRuleLine, { minLength: 0, maxLength: 6 });

describe('matcher-stack properties', () => {
  describe('Given an empty stack and any path', () => {
    describe('When matchInStack is called', () => {
      it('Then the verdict is always "unset"', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCandidatePath(), fc.boolean(), (path, isDir) => {
            const result = matchInStack([], path, isDir);
            expect(result).toBe('unset');
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given a root-level stack (basedir = "")', () => {
    describe('When matchInStack is called', () => {
      it('Then the verdict equals matches(rules, path, isDir) (delegation invariant)', () => {
        // Arrange + Act + Assert — `matches` is independently tested in
        // match.test.ts; using it as the oracle proves matchInStack reduces
        // to the single-level case at the empty basedir without copying
        // matches' internal loop.
        fc.assert(
          fc.property(arbRuleLines, arbCandidatePath(), fc.boolean(), (rawRules, path, isDir) => {
            const rules = parseGitignore(rawRules.join('\n'));
            const stack: ReadonlyArray<IgnoreLevel> = [{ basedir: '', rules }];

            const result = matchInStack(stack, path, isDir);
            const expected = matches(rules, path, isDir);

            expect(result).toBe(expected);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a stack whose single level is anchored at a multi-segment basedir B', () => {
    describe('When matchInStack is called with a path B/<suffix>', () => {
      it('Then the verdict equals matches(rules, <suffix>, isDir) (relativization invariant)', () => {
        // Arrange + Act + Assert — `arbCandidatePath` yields multi-segment
        // basedirs (e.g. `src/foo`) so the `startsWith(prefix)` check inside
        // `relativize` is exercised with realistic nesting depth.
        fc.assert(
          fc.property(
            arbCandidatePath(),
            arbRuleLines,
            arbCandidatePath(),
            fc.boolean(),
            (basedir, rawRules, suffix, isDir) => {
              const rules = parseGitignore(rawRules.join('\n'));
              const fullPath = FilePath.from(`${basedir}/${suffix}`);
              const stack: ReadonlyArray<IgnoreLevel> = [{ basedir, rules }];

              const result = matchInStack(stack, fullPath, isDir);
              const expected = matches(rules, suffix, isDir);

              expect(result).toBe(expected);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a stack whose single level is anchored at basedir B and a path NOT under B', () => {
    describe('When matchInStack is called', () => {
      it('Then the verdict is "unset" (relativize skips out-of-scope paths)', () => {
        // Arrange + Act + Assert — the `relative === undefined` branch in
        // `relativize` is only reachable when the path does not start with
        // `basedir + '/'`. This property covers that branch.
        fc.assert(
          fc.property(
            arbLiteralPattern(),
            arbLiteralPattern(),
            arbRuleLines,
            fc.boolean(),
            (basedirHead, otherHead, rawRules, isDir) => {
              fc.pre(basedirHead !== otherHead);
              const rules = parseGitignore(rawRules.join('\n'));
              const basedir = FilePath.from(basedirHead);
              const outOfScope = FilePath.from(`${otherHead}/leaf`);
              const stack: ReadonlyArray<IgnoreLevel> = [{ basedir, rules }];

              const result = matchInStack(stack, outOfScope, isDir);

              expect(result).toBe('unset');
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('judgeBeneathChain properties', () => {
  describe('Given a path whose leading directory is excluded by a root rule', () => {
    describe('When the path is matched beneath its leading directories', () => {
      it('Then it is ignored by that rule whatever follows it', () => {
        // Arrange
        let ignoredRuns = 0;
        let runs = 0;

        // Act + Assert
        fc.assert(
          fc.property(arbExcludedDirectoryCase(), (generated) => {
            const result = judgeBeneathChain(generated.stack, generated.path, generated.isDir);
            runs += 1;
            if (result.verdict === 'ignored') ignoredRuns += 1;
            expect(result.verdict).toBe('ignored');
            expect(result.level).toBe(generated.stack[0]);
            expect(result.ruleIndex).toBe(generated.excludingIndex);
          }),
          { numRuns: 100 },
        );
        expect(ignoredRuns).toBe(runs);
      });
    });
  });

  describe('Given a stack in which no leading directory of the path is excluded', () => {
    describe('When the path is matched beneath its leading directories', () => {
      it('Then the result is the plain stack match of the full path', () => {
        // Arrange + Act + Assert — the oracle answers ignored in 24% of runs
        // (those are discarded; the rest exercise the full-path fallthrough).
        fc.assert(
          fc.property(arbStackWithoutExcludedLeadingDirectory(), ({ stack, path, isDir }) => {
            const prefixes = path.split('/').slice(0, -1);
            fc.pre(
              prefixes.every(
                (_, depth) =>
                  matchInStackVerbose(
                    stack,
                    prefixes.slice(0, depth + 1).join('/') as FilePath,
                    true,
                  ).verdict !== 'ignored',
              ),
            );

            const result = judgeBeneathChain(stack, path, isDir);

            expect(result).toEqual(matchInStackVerbose(stack, path, isDir));
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an excluded leading directory and levels beneath it or unrelated to it', () => {
    describe('When the path is matched beneath its leading directories', () => {
      it('Then those levels never change the answer', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbExcludedDirectoryCase().chain((generated) =>
              arbLevelsBeyondDirectory(generated.dirPath).map((levels) => ({ generated, levels })),
            ),
            ({ generated, levels }) => {
              const { stack, path, isDir } = generated;

              const result = judgeBeneathChain([...stack, ...levels], path, isDir);
              const expected = judgeBeneathChain(stack, path, isDir);

              expect(result.verdict).toBe(expected.verdict);
              expect(result.level).toBe(stack[0]);
              expect(result.ruleIndex).toBe(expected.ruleIndex);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given levels ordered ancestor-before-descendant in any permutation', () => {
    describe('When any list of paths is matched beneath its leading directories', () => {
      const BASEDIRS = ['a', 'a/b', 'c', 'c/d'];
      const PREFIXES = ['', ...BASEDIRS];
      const MAX_QUERIES = 5;
      const MAX_QUERY_SEGMENTS = 3;
      const summarise = (stack: ReadonlyArray<IgnoreLevel>, path: FilePath, isDir: boolean) => {
        const result = judgeBeneathChain(stack, path, isDir);
        return {
          verdict: result.verdict,
          ruleIndex: result.ruleIndex,
          basedir: result.level?.basedir,
        };
      };
      const depthOf = (basedir: string): number => basedir.split('/').length;

      it('Then the sibling order of levels does not change any answer', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbRuleLines,
            fc.tuple(arbRuleLines, arbRuleLines, arbRuleLines, arbRuleLines),
            fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
            fc
              .array(
                fc.tuple(
                  fc.constantFrom(...PREFIXES),
                  fc.array(arbLiteralPattern(), { minLength: 1, maxLength: MAX_QUERY_SEGMENTS }),
                  fc.boolean(),
                ),
                { minLength: 1, maxLength: MAX_QUERIES },
              )
              .chain((queries) =>
                fc.shuffledSubarray(queries, {
                  minLength: queries.length,
                  maxLength: queries.length,
                }),
              ),
            (rootRules, perLevel, order, queries) => {
              const levels = BASEDIRS.map((basedir, index) =>
                levelOf(basedir, perLevel[index] as string[]),
              );
              const base = [levelOf('', rootRules), ...levels];
              const permuted = [
                levelOf('', rootRules),
                ...order
                  .map((index) => levels[index] as IgnoreLevel)
                  .sort((left, right) => depthOf(left.basedir) - depthOf(right.basedir)),
              ];

              for (const [prefix, segments, isDir] of queries) {
                const path = [prefix, ...segments]
                  .filter((part) => part !== '')
                  .join('/') as FilePath;
                expect(summarise(permuted, path, isDir)).toEqual(summarise(base, path, isDir));
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

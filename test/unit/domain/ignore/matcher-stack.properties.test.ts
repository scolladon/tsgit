import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { matches } from '../../../../src/domain/ignore/match.js';
import {
  type IgnoreLevel,
  matchBeneathChain,
  matchInStack,
  matchInStackVerbose,
  parentDirectoryOf,
} from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import { FilePath } from '../../../../src/domain/objects/index.js';
import { arbCandidatePath, arbLiteralPattern } from '../pathspec/arbitraries.js';
import {
  arbExcludedDirectoryCase,
  arbLevelsBeyondDirectory,
  arbStackWithoutExcludedLeadingDirectory,
  chainOver,
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

describe('matchBeneathChain properties over a loaded stack', () => {
  describe('Given a path whose leading directory is excluded by a root rule', () => {
    describe('When the path is matched beneath its leading directories', () => {
      it('Then it is ignored by that rule whatever follows it', () => {
        // Arrange
        let ignoredRuns = 0;
        let runs = 0;

        // Act + Assert
        fc.assert(
          fc.property(arbExcludedDirectoryCase(), (generated) => {
            const chain = chainOver(generated.stack, parentDirectoryOf(generated.path));
            const result = matchBeneathChain(
              generated.stack,
              generated.path,
              generated.isDir,
              chain,
            );
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
        // Arrange + Act + Assert — about 24% of draws are discarded (a leading
        // directory is excluded); of the rest the oracle answers ignored in about
        // 20% and unignored in about 20% (20 000 samples, three times).
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

            const chain = chainOver(stack, parentDirectoryOf(path));

            const result = matchBeneathChain(stack, path, isDir, chain);

            expect(result).toEqual(matchInStackVerbose(stack, path, isDir));
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given root rules with and without a slash, and the empty path', () => {
    describe('When matched', () => {
      it('Then the verdict is the one the rules holding no slash at all give', () => {
        // Arrange
        const arbRootRule = fc.constantFrom('*', '/*', '!*', '!/*', '**', '/**', 'a', '/a', '*/');
        const arbRootRules = fc.array(arbRootRule, { minLength: 0, maxLength: 5 });
        let decidedRuns = 0;

        // Act + Assert
        fc.assert(
          fc.property(arbRootRules, fc.boolean(), (lines, isDir) => {
            const basenameLines = lines.filter((line) => !line.includes('/'));
            const stack = [{ basedir: '', rules: parseGitignore(lines.join('\n')) }] as const;

            const result = matchInStackVerbose(stack, '' as FilePath, isDir);
            const expected = matches(
              parseGitignore(basenameLines.join('\n')),
              '' as FilePath,
              isDir,
            );

            if (result.verdict !== 'unset') decidedRuns += 1;
            expect(result.verdict).toBe(expected);
          }),
          { numRuns: 100 },
        );
        expect(decidedRuns).toBeGreaterThan(0);
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

              const widened = [...stack, ...levels];
              const parent = parentDirectoryOf(path);

              const result = matchBeneathChain(widened, path, isDir, chainOver(widened, parent));
              const expected = matchBeneathChain(stack, path, isDir, chainOver(stack, parent));

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
});

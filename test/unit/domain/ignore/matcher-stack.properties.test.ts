import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type IgnoreLevel, matchInStack } from '../../../../src/domain/ignore/matcher-stack.js';
import { type IgnoreRule, parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import { arbCandidatePath, arbLiteralPattern } from '../pathspec/arbitraries.js';

// "Last winning" oracle, scoped to a single root-level stack: walk the
// rules in order, every match updates the verdict by its negate flag, and
// directory-only rules apply only when isDir is true. Returns 'unset' if
// no rule matches.
function lastWinningVerdict(
  rules: ReadonlyArray<IgnoreRule>,
  path: string,
  isDir: boolean,
): 'ignored' | 'unignored' | 'unset' {
  let verdict: 'ignored' | 'unignored' | 'unset' = 'unset';
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (rule.compiled.test(path)) {
      verdict = rule.negated ? 'unignored' : 'ignored';
    }
  }
  return verdict;
}

describe('matcher-stack properties', () => {
  describe('Given a single root-level stack with arbitrary rules and an arbitrary path', () => {
    describe('When matchInStack is called', () => {
      it('Then the verdict matches the hand-computed last-winning rule', () => {
        // Arrange + Act + Assert
        // Restrict to literal patterns so the matchers' verdicts depend
        // only on simple character comparisons — the property here is the
        // stack-aggregation shape, not the glob compiler (covered elsewhere).
        const arbRuleLine = fc
          .tuple(fc.boolean(), arbLiteralPattern(), fc.boolean())
          .map(([negate, body, dirOnly]) => `${negate ? '!' : ''}${body}${dirOnly ? '/' : ''}`);
        const arbRules = fc.array(arbRuleLine, { minLength: 0, maxLength: 6 });
        fc.assert(
          fc.property(arbRules, arbCandidatePath(), fc.boolean(), (rawRules, path, isDir) => {
            const rules = parseGitignore(rawRules.join('\n'));
            const stack: ReadonlyArray<IgnoreLevel> = [{ basedir: '', rules }];

            const expected = lastWinningVerdict(rules, path, isDir);
            const sut = matchInStack(stack, path, isDir);

            expect(sut).toBe(expected);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

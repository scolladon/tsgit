import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { matches } from '../../../../src/domain/ignore/match.js';
import { type IgnoreLevel, matchInStack } from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import { FilePath } from '../../../../src/domain/objects/index.js';
import { arbCandidatePath, arbLiteralPattern } from '../pathspec/arbitraries.js';

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
            const sut = matchInStack([], path, isDir);
            expect(sut).toBe('unset');
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

            const sut = matchInStack(stack, path, isDir);
            const expected = matches(rules, path, isDir);

            expect(sut).toBe(expected);
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

              const sut = matchInStack(stack, fullPath, isDir);
              const expected = matches(rules, suffix, isDir);

              expect(sut).toBe(expected);
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

              const sut = matchInStack(stack, outOfScope, isDir);

              expect(sut).toBe('unset');
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

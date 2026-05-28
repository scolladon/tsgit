import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type IgnoreRuleset,
  parseGitignore,
} from '../../../../src/domain/ignore/parse-gitignore.js';
import { arbGitignorePattern, arbGitignoreText } from './arbitraries.js';

// Reduce rules to the structurally-comparable shape: the opaque `compiled`
// matcher cannot be compared by `toEqual`, but everything else is plain data.
function structural(rules: IgnoreRuleset): ReadonlyArray<{
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
}> {
  return rules.map((rule) => ({
    pattern: rule.pattern,
    negated: rule.negated,
    directoryOnly: rule.directoryOnly,
    anchored: rule.anchored,
  }));
}

function rulesToText(rules: IgnoreRuleset): string {
  return rules.map((r) => r.pattern).join('\n');
}

describe('parse-gitignore properties', () => {
  describe('Given an arbitrary `.gitignore` text', () => {
    describe('When the rules are emitted back as lines and re-parsed', () => {
      it('Then the second parse yields structurally identical rules (parser idempotence)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbGitignoreText(), (text) => {
            const firstPass = parseGitignore(text);
            const secondPass = parseGitignore(rulesToText(firstPass));
            expect(structural(secondPass)).toEqual(structural(firstPass));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary list of pattern lines', () => {
    describe('When parsed', () => {
      it('Then the count of negated rules equals the count of `!`-prefixed input lines', () => {
        // Arrange + Act + Assert
        const arbPatternLines = fc.array(arbGitignorePattern(), { minLength: 0, maxLength: 8 });
        fc.assert(
          fc.property(arbPatternLines, (patterns) => {
            const text = patterns.join('\n');
            const sut = parseGitignore(text);
            const negatedRules = sut.filter((r) => r.negated).length;
            const negatedInputs = patterns.filter((p) => p.startsWith('!')).length;
            expect(negatedRules).toBe(negatedInputs);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary list of pattern lines', () => {
    describe('When parsed', () => {
      it('Then the count of directory-only rules equals the count of input lines ending with `/`', () => {
        // Arrange + Act + Assert
        const arbPatternLines = fc.array(arbGitignorePattern(), { minLength: 0, maxLength: 8 });
        fc.assert(
          fc.property(arbPatternLines, (patterns) => {
            const text = patterns.join('\n');
            const sut = parseGitignore(text);
            const directoryRules = sut.filter((r) => r.directoryOnly).length;
            const directoryInputs = patterns.filter((p) => p.endsWith('/')).length;
            expect(directoryRules).toBe(directoryInputs);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given arbitrary text composed only of `#`-prefixed comment lines', () => {
    describe('When parsed', () => {
      it('Then it yields zero rules', () => {
        // Arrange + Act + Assert
        const arbCommentText = fc
          .array(
            fc
              .string({ minLength: 0, maxLength: 20 })
              .filter((s) => !s.includes('\n'))
              .map((body) => `#${body}`),
            { minLength: 1, maxLength: 8 },
          )
          .map((lines) => lines.join('\n'));
        fc.assert(
          fc.property(arbCommentText, (text) => {
            const sut = parseGitignore(text);
            expect(sut).toEqual([]);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given arbitrary `.gitignore` text', () => {
    describe('When parsed', () => {
      it('Then every rule lineNumber falls within [1, sourceLineCount] and is strictly ascending', () => {
        // Arrange + Act + Assert — line numbers are 1-based source positions,
        // not rule indices: skipped (comment/blank) lines leave gaps.
        fc.assert(
          fc.property(arbGitignoreText(), (text) => {
            const sut = parseGitignore(text);
            const sourceLineCount = text.split('\n').length;
            let previous = 0;
            for (const rule of sut) {
              expect(rule.lineNumber).toBeGreaterThanOrEqual(1);
              expect(rule.lineNumber).toBeLessThanOrEqual(sourceLineCount);
              expect(rule.lineNumber).toBeGreaterThan(previous);
              previous = rule.lineNumber;
            }
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});

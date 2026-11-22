import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tokenizeIgnoreLine } from '../../../../src/domain/ignore/index.js';
import { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compileSparseRule, nonConeMatcher } from '../../../../src/domain/sparse/non-cone.js';
import type { SparseRule } from '../../../../src/domain/sparse/sparse-pattern.js';
import { arbCaseMask, flipAsciiCase } from '../path/arbitraries.js';

const NUM_RUNS = 100;
const arbLine = fc.stringMatching(/^\/[aAbB]{1,3}(\/[aAbB]{1,3})?\/?$/);
const arbPath = fc.stringMatching(/^[aAbB]{1,3}(\/[aAbB]{1,3}){0,2}$/);
const arbMask = arbCaseMask();

const tokenized = (line: string) => {
  const tokens = tokenizeIgnoreLine(line);
  if (tokens === undefined) throw new Error(`unexpected skipped line: ${line}`);
  return tokens;
};

describe('compileSparseRule properties', () => {
  describe('Given a folding rule', () => {
    describe('When the path has its ASCII case flipped', () => {
      it('Then the verdict is unchanged', () => {
        fc.assert(
          fc.property(arbLine, arbPath, arbMask, (line, path, mask) => {
            // Arrange
            const sut = compileSparseRule;

            // Act
            const result = sut(tokenized(line), line, { caseFold: true }).matcher.test(
              flipAsciiCase(path, mask),
            );

            // Assert
            expect(result).toBe(sut(tokenized(line), line, { caseFold: true }).matcher.test(path));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe('When the exact rule accepts a path', () => {
      it('Then the folding rule accepts it too', () => {
        fc.assert(
          fc.property(arbLine, arbPath, (line, path) => {
            // Arrange
            const exact = compileSparseRule(tokenized(line), line).matcher;
            const sut = compileSparseRule;

            // Act
            const result = sut(tokenized(line), line, { caseFold: true }).matcher.test(path);

            // Assert
            expect(result || !exact.test(path)).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given no option', () => {
    describe('When compared with caseFold false', () => {
      it('Then both rules reach the same verdict', () => {
        fc.assert(
          fc.property(arbLine, arbPath, (line, path) => {
            // Arrange
            const sut = compileSparseRule;

            // Act
            const result = sut(tokenized(line), line, { caseFold: false }).matcher.test(path);

            // Assert
            expect(result).toBe(sut(tokenized(line), line).matcher.test(path));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

const arbDirectory = fc.stringMatching(/^[aAbB]{1,3}(\/[aAbB]{1,3}){0,2}$/);
const arbBelow = fc.stringMatching(/^z{1,2}(\/z{1,2}){0,3}$/);
const arbAnyLine = fc.stringMatching(/^!?\/?[abAB*?]{1,3}(\/[abAB*?]{1,3})?\/?$/);
const arbLiteralLine = fc.stringMatching(/^!?\/?[abAB]{1,3}(\/[abAB]{1,3})?\/?$/);
const arbPolarity = fc.constantFrom('', '!');

const ruleOf = (line: string): SparseRule => compileSparseRule(tokenized(line), line);

const unmemoised = (rules: ReadonlyArray<SparseRule>, path: string): boolean => {
  const verdict = (target: string, isDirectory: boolean): boolean | undefined =>
    rules.reduce<boolean | undefined>(
      (last, rule) =>
        (rule.directoryOnly && !isDirectory) || !rule.matcher.test(target) ? last : !rule.negated,
      undefined,
    );
  const parents = path.split('/').slice(0, -1);
  const directories = parents.map((_, i) => parents.slice(0, i + 1).join('/')).reverse();
  const decided = [verdict(path, false), ...directories.map((d) => verdict(d, true))];
  return decided.find((v) => v !== undefined) ?? false;
};

describe('nonConeMatcher properties', () => {
  describe('Given any rules then a last rule deciding directory D', () => {
    describe('When a descendant of D is named by no rule', () => {
      it('Then it takes the verdict of D', () => {
        fc.assert(
          fc.property(
            fc.array(arbLiteralLine, { maxLength: 5 }),
            arbDirectory,
            arbPolarity,
            arbBelow,
            (lines, directory, polarity, below) => {
              // Arrange
              const last = `${polarity}/${directory}/`;
              const sut = nonConeMatcher([...lines, last].map(ruleOf));

              // Act
              const result = sut(FilePath.from(`${directory}/${below}`));

              // Assert
              expect(result).toBe(polarity === '');
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given any rules and a sequence of paths on one matcher', () => {
    describe('When each path is judged', () => {
      it('Then the memoised verdict equals the unmemoised one', () => {
        fc.assert(
          fc.property(
            fc.array(arbAnyLine, { maxLength: 6 }),
            fc.array(arbPath, { minLength: 1, maxLength: 8 }),
            (lines, paths) => {
              // Arrange
              const rules = lines.map(ruleOf);
              const sut = nonConeMatcher(rules);

              // Act
              const results = paths.map((p) => sut(FilePath.from(p)));

              // Assert
              expect(results).toEqual(paths.map((p) => unmemoised(rules, p)));
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

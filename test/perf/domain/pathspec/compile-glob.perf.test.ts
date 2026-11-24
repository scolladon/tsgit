import { describe, expect, it } from 'vitest';
import { encodeEscaped } from '../../../../src/domain/objects/encoding.js';
import { compileGlob, type GlobMatcher } from '../../../../src/domain/pathspec/compile-glob.js';
import { asciiLower } from '../../../../src/domain/pretty/ascii.js';

const RULE_COUNT = 40;
const PATH_COUNT = 5000;
/** `[ab]` this many times is one megabyte, the largest ignore file read. */
const REPEATED_SETS = 262_144;
const PASSES = 7;
/**
 * A rule set owes one preparation (fold, encode) per path. The gates compare
 * its cost with the same preparation repeated once per rule: paying it per
 * rule costs at least that much, paying it per path a small share of it.
 */
const MAX_SHARE_OF_PER_RULE_WORK = 0.5;

/** The subject each rule sees for a path: attribute rules alternate the path and its basename. */
type SubjectOf = (path: string, rule: number) => string;

const wholePath: SubjectOf = (path) => path;
const pathOrBasename: SubjectOf = (path, rule) =>
  rule % 2 === 0 ? path : path.slice(path.lastIndexOf('/') + 1);

const bestMs = (work: () => void): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < PASSES; pass++) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

/** Every rule tests its subject of every path, as a rule set does. */
const matchingMs = (
  rules: ReadonlyArray<GlobMatcher>,
  paths: ReadonlyArray<string>,
  subjectOf: SubjectOf,
): number =>
  bestMs(() => {
    for (const path of paths) {
      for (let rule = 0; rule < rules.length; rule++) {
        (rules[rule] as GlobMatcher).test(subjectOf(path, rule));
      }
    }
  });

/** The same subjects, each prepared once per rule and never matched. */
const perRuleWorkMs = (
  prepare: (subject: string) => { readonly length: number },
  paths: ReadonlyArray<string>,
  subjectOf: SubjectOf,
): number => {
  const sink = { length: 0 };
  return bestMs(() => {
    for (const path of paths) {
      for (let rule = 0; rule < RULE_COUNT; rule++) {
        sink.length += prepare(subjectOf(path, rule)).length;
      }
    }
  });
};

// The non-ASCII letter keeps the fold on its letter-by-letter path, where
// folding a path again for every rule costs the most.
const MIXED_CASE_PATHS = Array.from(
  { length: PATH_COUNT },
  (_, index) => `Dir${index}/Café.Ext${index}`,
);
const LOWER_CASE_PATHS = MIXED_CASE_PATHS.map(asciiLower);

/**
 * Wall-clock ReDoS guard for the glob matcher. This is a PERFORMANCE test, not
 * a unit test: it asserts an elapsed-time budget, which is load-dependent and
 * therefore excluded from the `unit` project that Stryker mutates (only
 * behavioural unit tests should decide whether a mutant is killed). It runs in
 * the dedicated `perf` project (`npm run test:perf`).
 */
describe('compileGlob (performance)', () => {
  describe('Given an adversarial `a*a*…*b` pattern', () => {
    describe('When matched against a long non-matching run', () => {
      it('Then it returns false without catastrophic backtracking', () => {
        // Arrange — the ReDoS regression. The old regex `^a[^/]*a[^/]*…b$` would
        // explore exponentially many splits of the `a`-run and hang the test;
        // the linear matcher fills a table in O(tokens × length).
        const sut = compileGlob(`${'a*'.repeat(64)}b`, { anchored: true });
        const adversarial = 'a'.repeat(10_000);

        // Act
        const start = performance.now();
        const result = sut.test(adversarial);
        const elapsedMs = performance.now() - start;

        // Assert — no `b`, so no match; and it completes near-instantly.
        expect(result).toBe(false);
        expect(elapsedMs).toBeLessThan(1000);
      });
    });
  });

  describe('Given an adversarial [a-z]* run', () => {
    describe('When matched against 10000 a', () => {
      it('Then it returns false within 1000 ms', () => {
        // Arrange
        const sut = compileGlob(`${'[a-z]*'.repeat(64)}b`, { anchored: true });
        const adversarial = 'a'.repeat(10_000);

        // Act
        const start = performance.now();
        const result = sut.test(adversarial);
        const elapsedMs = performance.now() - start;

        // Assert
        expect(result).toBe(false);
        expect(elapsedMs).toBeLessThan(1000);
      });
    });
  });

  describe('Given 40 folding rules and 5000 mixed-case paths', () => {
    const rules = Array.from({ length: RULE_COUNT }, (_, rule) =>
      compileGlob(`*.ext${rule}`, { anchored: false, caseFold: true }),
    );

    describe('When every rule tests every path', () => {
      it('Then matching costs under half of folding the path once per rule', () => {
        // Arrange
        const sut = rules;

        // Act
        const result = matchingMs(sut, MIXED_CASE_PATHS, wholePath);
        const perRuleMs = perRuleWorkMs(asciiLower, MIXED_CASE_PATHS, wholePath);

        // Assert
        expect(result).toBeLessThan(perRuleMs * MAX_SHARE_OF_PER_RULE_WORK);
      });
    });

    describe('When the rules alternate between the path and its basename', () => {
      it('Then matching still costs under half of folding once per rule', () => {
        // Arrange
        const sut = rules;

        // Act
        const result = matchingMs(sut, MIXED_CASE_PATHS, pathOrBasename);
        const perRuleMs = perRuleWorkMs(asciiLower, MIXED_CASE_PATHS, pathOrBasename);

        // Assert
        expect(result).toBeLessThan(perRuleMs * MAX_SHARE_OF_PER_RULE_WORK);
      });
    });
  });

  // Both tails are gated: one ends in plain bytes, the other in a set, so a
  // refusal that reads only one kind of token fails one of the two families.
  describe.each([
    ['a fixed byte run', (rule: number): string => `*.e[xy]t${rule}`],
    ['a set', (rule: number): string => `*.e[xy]t${rule}[a-z]`],
  ] as const)('Given 40 star-led rules ending in %s and 5000 paths', (_tail, patternOf) => {
    const rules = Array.from({ length: RULE_COUNT }, (_, rule) =>
      compileGlob(patternOf(rule), { anchored: false }),
    );

    describe('When every rule tests every path', () => {
      it('Then matching costs under half of encoding the path once per rule', () => {
        // Arrange
        const sut = rules;

        // Act
        const result = matchingMs(sut, LOWER_CASE_PATHS, wholePath);
        const perRuleMs = perRuleWorkMs(encodeEscaped, LOWER_CASE_PATHS, wholePath);

        // Assert
        expect(result).toBeLessThan(perRuleMs * MAX_SHARE_OF_PER_RULE_WORK);
      });
    });

    describe('When the rules alternate between the path and its basename', () => {
      it('Then matching still costs under half of encoding once per rule', () => {
        // Arrange
        const sut = rules;

        // Act
        const result = matchingMs(sut, LOWER_CASE_PATHS, pathOrBasename);
        const perRuleMs = perRuleWorkMs(encodeEscaped, LOWER_CASE_PATHS, pathOrBasename);

        // Assert
        expect(result).toBeLessThan(perRuleMs * MAX_SHARE_OF_PER_RULE_WORK);
      });
    });
  });

  describe('Given a megabyte line repeating one two-member set', () => {
    describe('When compiled', () => {
      it('Then it compiles within 1000 ms', () => {
        // Arrange
        const pattern = '[ab]'.repeat(REPEATED_SETS);

        // Act
        const start = performance.now();
        const sut = compileGlob(pattern, { anchored: true });
        const elapsedMs = performance.now() - start;

        // Assert
        expect(sut.test('a'.repeat(REPEATED_SETS - 1))).toBe(false);
        expect(elapsedMs).toBeLessThan(1000);
      });
    });
  });

  describe('Given a bracket set holding 100000 class openers', () => {
    describe('When compiled', () => {
      it('Then it compiles within 1000 ms', () => {
        // Arrange
        const pattern = `[${'[:'.repeat(100_000)}x]`;

        // Act
        const start = performance.now();
        const sut = compileGlob(pattern, { anchored: true });
        const elapsedMs = performance.now() - start;

        // Assert
        expect(sut.test('x')).toBe(true);
        expect(elapsedMs).toBeLessThan(1000);
      });
    });
  });
});

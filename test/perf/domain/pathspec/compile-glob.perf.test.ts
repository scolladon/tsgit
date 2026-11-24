import { describe, expect, it } from 'vitest';
import { compileGlob, type GlobMatcher } from '../../../../src/domain/pathspec/compile-glob.js';

const RULE_COUNT = 40;
const PATH_COUNT = 5000;
const PASSES = 7;
const MAX_FOLD_RATIO = 3;

/** One pass tests every path against every rule, as a rule set does; the fastest pass is kept. */
const bestPassMs = (rules: ReadonlyArray<GlobMatcher>, paths: ReadonlyArray<string>): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < PASSES; pass++) {
    const start = performance.now();
    for (const path of paths) for (const rule of rules) rule.test(path);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

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

  describe('Given 40 rules and 5000 mixed-case paths', () => {
    describe('When every rule tests every path with and without case folding', () => {
      it('Then folding costs under three times the case-exact pass', () => {
        // Arrange — a rule set tests one path against every rule, so the fold of
        // a path is owed once per path, not once per rule.
        const patterns = Array.from({ length: RULE_COUNT }, (_, rule) => `*.ext${rule}`);
        const paths = Array.from(
          { length: PATH_COUNT },
          (_, index) => `Dir${index}/File.Ext${index}`,
        );
        const exact = patterns.map((pattern) => compileGlob(pattern, { anchored: false }));
        const folded = patterns.map((pattern) =>
          compileGlob(pattern, { anchored: false, caseFold: true }),
        );

        // Act
        const exactMs = bestPassMs(exact, paths);
        const foldedMs = bestPassMs(folded, paths);

        // Assert
        expect(foldedMs).toBeLessThan(exactMs * MAX_FOLD_RATIO);
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

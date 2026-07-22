import { describe, expect, it } from 'vitest';
import { compileGlob } from '../../../../src/domain/pathspec/compile-glob.js';

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
});

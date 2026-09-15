import { describe, expect, it } from 'vitest';
import { compileRefGlob } from '../../../../src/domain/refs/ref-glob.js';

/**
 * Wall-clock ReDoS guard for the ref-glob matcher. This is a PERFORMANCE
 * test, not a unit test: it asserts an elapsed-time budget, which is
 * load-dependent and therefore excluded from the `unit` project that Stryker
 * mutates. It runs in the dedicated `perf` project (`npm run test:perf`).
 *
 * `gc.<pattern>.*` keys read patterns straight from repository configuration,
 * which a planted `.git/config` controls — the same ReDoS class
 * `compile-glob.perf.test.ts` closes for pathspecs must stay closed here too.
 */
describe('compileRefGlob (performance)', () => {
  describe('Given an adversarial `a*a*…*b` pattern', () => {
    describe('When matched against a long non-matching run', () => {
      it('Then it returns false without catastrophic backtracking', () => {
        // Arrange — a backtracking matcher explores exponentially many splits
        // of the `a`-run trying to place the trailing `b`; the linear matcher
        // fills a table in O(tokens × length) regardless.
        const sut = compileRefGlob(`${'a*'.repeat(64)}b`);
        const adversarial = 'a'.repeat(10_000);

        // Act
        const start = performance.now();
        const result = sut(adversarial);
        const elapsedMs = performance.now() - start;

        // Assert — no `b`, so no match; and it completes near-instantly.
        expect(result).toBe(false);
        expect(elapsedMs).toBeLessThan(1000);
      });
    });
  });
});

import { describe, expect, it } from 'vitest';

import type { RefName } from '../../../../src/domain/objects/index.js';
import { takenNameIndex } from '../../../../src/domain/refs/taken-name-index.js';

/**
 * Wall-clock scaling guard for the ref transaction's "has the run already taken
 * a name under this one?" question. This is a PERFORMANCE test, not a unit
 * test: it asserts an elapsed-time budget, which is load-dependent and
 * therefore excluded from the `unit` project that Stryker mutates. It runs in
 * the dedicated `perf` project (`npm run test:perf`).
 *
 * The prepare pass used to answer by scanning every name taken so far — one
 * string comparison per earlier name, quadratic in the run size, and minutes of
 * comparisons at the size below. The prefix index answers by lookup.
 */
const RUN_SIZE = 50_000;
const BUDGET_MS = 1_000;

describe('takenNameIndex (performance)', () => {
  describe('Given a bulk run whose names all share one namespace', () => {
    describe('When every name is queried and then taken in turn', () => {
      it('Then the whole pass finishes well inside a linear budget', () => {
        // Arrange
        const sut = takenNameIndex();
        const names = Array.from(
          { length: RUN_SIZE },
          (_unused, index) => `refs/remotes/origin/branch-${index}` as RefName,
        );

        // Act
        const start = performance.now();
        let held = 0;
        for (const name of names) {
          if (sut.holdsUnder(name)) held += 1;
          sut.take(name);
        }
        const elapsedMs = performance.now() - start;

        // Assert — no name of the run nests under another, and it is quick.
        expect(held).toBe(0);
        expect(elapsedMs).toBeLessThan(BUDGET_MS);
      });
    });
  });
});

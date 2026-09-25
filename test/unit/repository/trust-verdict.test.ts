import { describe, expect, it } from 'vitest';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import type { WalkOutcome } from '../../../src/repository/find-layout.js';
import { evaluateTrust } from '../../../src/repository/trust-verdict.js';

// Direct unit tests of `evaluateTrust`, bypassing `resolveLayout`'s
// filesystem-driven discovery entirely — a hand-crafted `WalkOutcome` plus a
// minimal stub `LayoutProbe` isolate the allowlist default from every other
// stage of layout resolution.

/**
 * The repository path this row keys on, and the one detail in it that is not
 * arbitrary.
 *
 * `isAllowlisted` matches an entry only by equality or by a `<prefix>/*`
 * prefix, so a wrongly-populated default allowlist is invisible to every path
 * except one it literally contains. Pinning "the default is empty" therefore
 * requires standing the repository exactly where a non-empty default would
 * put its entry. This string is the placeholder the mutation runner
 * substitutes for the empty array, so it is the value that makes the
 * difference observable rather than a value chosen for its own sake.
 */
const PATH_ONLY_A_POPULATED_DEFAULT_WOULD_MATCH = 'Stryker was here';

describe('evaluateTrust', () => {
  describe('Given trustedDirectories is omitted and the repository path is not owned by the caller', () => {
    describe('When evaluateTrust runs', () => {
      it('Then it refuses trust — the omitted-allowlist default is genuinely empty, not populated', async () => {
        // Arrange — `opts.trustedDirectories ?? []` only matters when the
        // option is omitted; an `isOwnedByCaller` that always refuses turns
        // "the default matched" into an observable TRUSTED verdict instead
        // of the refusal this row expects.
        const path = PATH_ONLY_A_POPULATED_DEFAULT_WOULD_MATCH;
        const outcome: WalkOutcome = { route: 'EXPLICIT', gitDir: path };
        const probe: LayoutProbe = {
          stat: async () => undefined,
          readUtf8: async () => undefined,
          isOwnedByCaller: async () => false,
        };
        const sut = evaluateTrust;

        // Act
        const result = await sut(probe, outcome, path, {});

        // Assert
        expect(result).toStrictEqual({ trusted: false, foreignPath: path });
      });
    });
  });

  describe('Given two checked paths, both unowned', () => {
    describe('When evaluateTrust runs', () => {
      it('Then it reports the first one in iteration order, though both were queried', async () => {
        // Arrange — the serial form would never query the common dir once
        // the repository path already decided the verdict; the batched form
        // starts every checked path at once, so both calls are observed here.
        const outcome: WalkOutcome = { route: 'EXPLICIT', gitDir: '/repo/.git' };
        const commonDir = '/repo/common';
        const calls: string[] = [];
        const probe: LayoutProbe = {
          stat: async () => undefined,
          readUtf8: async () => undefined,
          isOwnedByCaller: async (path) => {
            calls.push(path);
            return false;
          },
        };
        const sut = evaluateTrust;

        // Act
        const result = await sut(probe, outcome, commonDir, {});

        // Assert
        expect(result).toStrictEqual({ trusted: false, foreignPath: '/repo/.git' });
        expect(calls).toStrictEqual(['/repo/.git', '/repo/common']);
      });
    });
  });

  describe('Given the first checked path is unowned and a later one rejects', () => {
    describe('When evaluateTrust runs', () => {
      it('Then the first foreign path is reported and the later rejection never surfaces', async () => {
        // Arrange
        const outcome: WalkOutcome = { route: 'EXPLICIT', gitDir: '/repo/.git' };
        const commonDir = '/repo/common';
        const probe: LayoutProbe = {
          stat: async () => undefined,
          readUtf8: async () => undefined,
          isOwnedByCaller: async (path) =>
            path === '/repo/.git' ? false : Promise.reject(new Error('must not be surfaced')),
        };
        const sut = evaluateTrust;

        // Act
        const result = await sut(probe, outcome, commonDir, {});

        // Assert
        expect(result).toStrictEqual({ trusted: false, foreignPath: '/repo/.git' });
      });
    });
  });

  describe('Given every earlier checked path is owned and the last one rejects', () => {
    describe('When evaluateTrust runs', () => {
      it('Then the rejection propagates untouched', async () => {
        // Arrange
        const outcome: WalkOutcome = { route: 'EXPLICIT', gitDir: '/repo/.git' };
        const commonDir = '/repo/common';
        const boom = new Error('isOwnedByCaller boom');
        const probe: LayoutProbe = {
          stat: async () => undefined,
          readUtf8: async () => undefined,
          isOwnedByCaller: async (path) => (path === '/repo/.git' ? true : Promise.reject(boom)),
        };
        const sut = evaluateTrust;

        // Act
        let caught: unknown;
        try {
          await sut(probe, outcome, commonDir, {});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(boom);
      });
    });
  });
});

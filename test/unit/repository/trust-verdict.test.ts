import { describe, expect, it } from 'vitest';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import type { WalkOutcome } from '../../../src/repository/find-layout.js';
import { evaluateTrust } from '../../../src/repository/trust-verdict.js';

// Direct unit tests of `evaluateTrust`, bypassing `resolveLayout`'s
// filesystem-driven discovery entirely — a hand-crafted `WalkOutcome` plus a
// minimal stub `LayoutProbe` isolate the allowlist default from every other
// stage of layout resolution.

describe('evaluateTrust', () => {
  describe('Given trustedDirectories is omitted and the repository path is not owned by the caller', () => {
    describe('When evaluateTrust runs', () => {
      it('Then it refuses trust — the omitted-allowlist default is genuinely empty, not populated', async () => {
        // Arrange — `opts.trustedDirectories ?? []` only matters when the
        // option is omitted; an `isOwnedByCaller` that always refuses turns
        // "the default matched" into an observable TRUSTED verdict instead
        // of the refusal this row expects.
        const outcome: WalkOutcome = { route: 'EXPLICIT', gitDir: 'Stryker was here' };
        const probe: LayoutProbe = {
          stat: async () => undefined,
          readUtf8: async () => undefined,
          isOwnedByCaller: async () => false,
        };

        // Act
        const result = await evaluateTrust(probe, outcome, 'Stryker was here', {});

        // Assert
        expect(result).toStrictEqual({ trusted: false, foreignPath: 'Stryker was here' });
      });
    });
  });
});

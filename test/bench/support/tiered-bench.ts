/**
 * Tiered bench helper — mirrors `scaled-bench.ts`'s single-fixture
 * resolution, but registers one scenario per fixture tier so a plain-shape
 * hot bench (`log`/`status`/`pack-read`) measures small and medium (always)
 * plus large under `TSGIT_BENCH_LARGE` in the same file.
 */
import type { BenchComparison } from './bench-dsl.js';
import {
  DEEP_ANCESTRY_LARGE,
  DEEP_ANCESTRY_MEDIUM,
  DEEP_ANCESTRY_SMALL,
  type FixtureSpec,
  LARGE_FIXTURE,
  MEDIUM_FIXTURE,
  type ScaledFixture,
  SMALL_FIXTURE,
} from './fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './scaled-bench.js';

export interface TierSpecs {
  readonly small: FixtureSpec;
  readonly medium: FixtureSpec;
  readonly large: FixtureSpec;
}

export const MULTI_TIERS: TierSpecs = {
  small: SMALL_FIXTURE,
  medium: MEDIUM_FIXTURE,
  large: LARGE_FIXTURE,
};

export const DEEP_ANCESTRY_TIERS: TierSpecs = {
  small: DEEP_ANCESTRY_SMALL,
  medium: DEEP_ANCESTRY_MEDIUM,
  large: DEEP_ANCESTRY_LARGE,
};

/**
 * Registers `whenThen` once per tier: small + medium always, large only
 * when `TSGIT_BENCH_LARGE` is set. Each tier resolves its own fixture
 * context, so its describe title (and gate key) stays tier-distinct.
 */
export const tieredScenario = async (
  tiers: TierSpecs,
  whenThen: string,
  build: (fixture: ScaledFixture) => Promise<BenchComparison> | BenchComparison,
): Promise<void> => {
  const specs: readonly FixtureSpec[] = [
    tiers.small,
    tiers.medium,
    ...(process.env.TSGIT_BENCH_LARGE !== undefined ? [tiers.large] : []),
  ];

  for (const spec of specs) {
    const ctx = await resolveScaledContext(spec);
    scaledScenario(ctx, whenThen, build);
  }
};

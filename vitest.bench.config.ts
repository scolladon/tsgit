import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      include: ['test/bench/**/*.bench.ts'],
      outputJson: 'reports/benchmarks/raw.json',
    },
    // Benchmarks own the timeout. The scaled scenarios (Phase 15.1) walk
    // 20k-file / 5k-commit fixtures — isomorphic-git's `statusMatrix` over
    // that tree is slow enough to need generous headroom over a CI run.
    testTimeout: 120_000,
  },
});

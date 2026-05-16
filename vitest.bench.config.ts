import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      include: ['test/bench/**/*.bench.ts'],
      outputJson: 'reports/benchmarks/raw.json',
    },
    // Benchmarks own the timeout; isomorphic-git's first call against a fresh
    // repo can hit a few hundred ms on cold cache.
    testTimeout: 60_000,
  },
});

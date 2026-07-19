import { defineConfig } from 'vitest/config';

// Performance tests assert wall-clock budgets (e.g. the glob ReDoS guard), which
// are load-dependent. They live in their OWN config — not a project of
// vitest.config.ts — because Stryker's vitest runner executes every project of
// the config it loads, and a mutant must be killed by a behavioural assertion,
// never a timing one. Run with `npm run test:perf`.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    env: { TZ: 'UTC' },
    // Wall-clock guards need headroom over the 5s default on a loaded machine.
    testTimeout: 120_000,
  },
});

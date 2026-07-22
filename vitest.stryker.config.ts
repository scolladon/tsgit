import { defineConfig } from 'vitest/config';

// Stryker gets its own vitest config, for two independently-verified reasons.
//
// Single project: Stryker's vitest runner executes every project in the config
// it loads, so the multi-project vitest.config.ts drags integration and parity
// suites into a run that should only mutate against unit tests. (Same reason
// the wall-clock perf suite lives in vitest.perf.config.ts.)
//
// No `maxWorkers`: inheriting `maxWorkers: '100%'` prevents Stryker's active-
// mutant and coverage globals from reaching vitest's workers, so mutants never
// activate — every test then runs against unmutated code and the run reports
// zero kills. Leaving worker management to Stryker is what makes per-test
// coverage attribution work at all.
//
// Keep the settings below in sync with the `unit` project in vitest.config.ts.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'tooling/test/unit/**/*.test.ts'],
    testTimeout: 120_000,
    env: { TZ: 'UTC' },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Boundary tests exercise genuinely large limits (1M tree entries,
    // multi-megabyte caps, million-iteration diff budgets). They finish in a
    // few seconds normally, but Stryker's per-statement coverage
    // instrumentation amplifies tight-loop cost far past the 5s default — so
    // the suite uses a generous ceiling rather than spuriously timing out.
    testTimeout: 120_000,
    // Pin the timezone so calendar-component date arithmetic (approxidate's
    // ISO-form parsing) is deterministic across hosts and CI runners.
    env: { TZ: 'UTC' },
    // Use every logical core (default is n-1 on runs and n/2 in watch mode);
    // the percentage form scales to each machine, so CI stays safe.
    maxWorkers: '100%',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'tooling/test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts', 'tooling/test/integration/**/*.test.ts'],
          exclude: [
            // Folder-segregated platform-specific integration suites run in
            // their own CI jobs (posix-integration + win-integration).
            'test/integration/posix-only/**',
            'test/integration/win-only/**',
            // Also exclude node_modules (default) — restated when overriding
            // the default `exclude` array.
            '**/node_modules/**',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'posix-integration',
          include: ['test/integration/posix-only/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'win-integration',
          include: ['test/integration/win-only/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          // Cross-adapter parity drivers. Runs the same scenarios against
          // Node and Memory adapters and asserts byte-identical results.
          // The Browser driver lives in test/browser/parity.spec.ts and
          // runs through Playwright.
          name: 'parity',
          include: ['test/parity/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/domain/**/*.ts',
        'src/ports/**/*.ts',
        'src/adapters/node/**/*.ts',
        'src/adapters/memory/**/*.ts',
        'src/operators/**/*.ts',
      ],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});

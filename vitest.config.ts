import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
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

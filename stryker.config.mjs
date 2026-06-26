// Stryker configuration.
//
// `concurrency` scales with the wall clock so mutation runs don't saturate a
// developer's machine during working hours, while taking full advantage of an
// otherwise-idle machine at night and on weekends. The value is resolved once,
// when Stryker loads this config (Stryker cannot re-tune concurrency mid-run).
//
// Schedule (local time): weekdays 08:00–20:00 → 30% of logical cores; nights and
// all weekend → 100%. CI runners are never a developer's workstation, so they
// always run at full power regardless of when the job is triggered.

/** @returns {`${number}%`} */
function scheduledConcurrency() {
  if (process.env.CI) return '100%';

  const now = new Date();
  const weekday = now.getDay(); // 0 = Sunday … 6 = Saturday
  const isWeekend = weekday === 0 || weekday === 6;
  const isWorkingHours = now.getHours() >= 8 && now.getHours() < 20;

  return !isWeekend && isWorkingHours ? '30%' : '100%';
}

export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  mutate: ['src/**/*.ts', '!src/**/index.ts', '!src/**/*.d.ts', '!src/adapters/browser/**/*.ts'],
  vitest: { configFile: 'vitest.config.ts', dir: 'test/unit' },
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  thresholds: { high: 100, low: 95, break: 90 },
  concurrency: scheduledConcurrency(),
  timeoutMS: 60000,
  timeoutFactor: 2,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  ignoreStatic: true,
  incrementalFile: 'reports/stryker-incremental.json',
};

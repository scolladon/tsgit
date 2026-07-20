// Stryker configuration.
//
// `concurrency` scales with the wall clock so mutation runs don't saturate a
// developer's machine during working hours, while taking full advantage of an
// otherwise-idle machine at night and on weekends. The value is resolved once,
// when Stryker loads this config (Stryker cannot re-tune concurrency mid-run).
//
// Schedule (local time): weekdays 08:00–20:00 → 30% of logical cores; nights and
// all weekend → 75%. Off-hours stops short of 100% because a full-power run
// starves the machine: every worker loads the whole unit suite, and saturating
// the cores exhausted memory badly enough to trip the kernel's userspace
// watchdog. CI runners are never a developer's workstation, so they always run
// at full power regardless of when the job is triggered.

/** @returns {`${number}%`} */
function scheduledConcurrency() {
  if (process.env.CI) return '100%';

  const now = new Date();
  const weekday = now.getDay(); // 0 = Sunday … 6 = Saturday
  const isWeekend = weekday === 0 || weekday === 6;
  const isWorkingHours = now.getHours() >= 8 && now.getHours() < 20;

  return !isWeekend && isWorkingHours ? '30%' : '75%';
}

export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  mutate: ['src/**/*.ts', '!src/**/index.ts', '!src/**/*.d.ts', '!src/adapters/browser/**/*.ts'],
  // `related: false` because the runner's default is to keep only the tests
  // vitest's module graph links to each mutated file. Our tests import sources
  // through `.js` specifiers, which that graph under-resolves badly — the dry
  // run collected 564 of 10344 tests, and for some files none at all, leaving
  // mutants with no tests to kill them and the report full of phantom survivors.
  vitest: { configFile: 'vitest.stryker.config.ts', related: false },
  coverageAnalysis: 'perTest',
  // The Regex mutator emits its variants as literals inline beside the original,
  // so all of them are parsed when the module loads. It generates case-flipped
  // escapes, and `\V` is invalid under the `u` flag: one such variant makes the
  // whole module throw at import time, which silently drops every test that
  // imports it and reports all of that file's mutants as survived. Excluding
  // the mutator is the only workaround found — spelling the vertical tab as an
  // explicit code-point escape in the source does not help, since the flip then
  // produces an equally invalid uppercase form. Cost: regex mutants go untested
  // until this is fixed upstream.
  mutator: { excludedMutations: ['Regex'] },
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

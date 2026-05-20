#!/usr/bin/env node
/**
 * Pre-warm a scaled benchmark fixture cache.
 *
 *   npm run bench:fixture -- medium
 *   npm run bench:fixture -- large
 *
 * First run generates the repo under ~/.cache/tsgit-bench; later runs are
 * cache hits. Run this before `npm run test:bench` / `npm run profile` so the
 * scaled benches never pay generation cost inside the measured run.
 */
import {
  LARGE_FIXTURE,
  MEDIUM_FIXTURE,
  ensureScaledFixture,
} from '../test/bench/support/fixture-generator.ts';

const main = async (): Promise<void> => {
  const label = process.argv[2];
  const spec =
    label === 'large' ? LARGE_FIXTURE : label === 'medium' ? MEDIUM_FIXTURE : undefined;
  if (spec === undefined) {
    process.stderr.write('usage: gen-bench-fixture <medium|large>\n');
    process.exit(1);
  }

  const start = Date.now();
  const fixture = await ensureScaledFixture(spec);
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(
    `${spec.label} fixture ready in ${seconds}s\n` +
      `  path: ${fixture.cwd}\n` +
      `  HEAD: ${fixture.headCommitId}\n`,
  );
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

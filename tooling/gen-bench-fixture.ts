#!/usr/bin/env node
/**
 * Pre-warm a scaled benchmark fixture cache, or reclaim stale ones.
 *
 *   npm run bench:fixture -- medium
 *   npm run bench:fixture -- large
 *   npm run bench:fixture -- delta-chain
 *   npm run bench:fixture -- many-pack
 *   npm run bench:fixture -- --prune
 *
 * First run generates the repo under ~/.cache/tsgit-bench; later runs are
 * cache hits. Run this before `npm run test:bench` / `npm run profile` so the
 * scaled benches never pay generation cost inside the measured run.
 * `--prune` reclaims the cache directories `fixture-generator.ts` no longer
 * builds — a deliberate developer action, never run automatically.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DELTA_CHAIN_FIXTURE,
  ensureScaledFixture,
  type FixtureSpec,
  LARGE_FIXTURE,
  MANY_PACK_FIXTURE,
  MEDIUM_FIXTURE,
} from '../test/bench/support/fixture-generator.ts';
import { pruneFixtureCache } from '../test/bench/support/fixture-prune.ts';

type FixtureAction =
  | { readonly kind: 'generate'; readonly spec: FixtureSpec }
  | { readonly kind: 'prune' }
  | { readonly kind: 'usage' };

const USAGE = 'usage: gen-bench-fixture <medium|large|delta-chain|many-pack|--prune>\n';

/** Pure argv routing — exported so it can be unit-tested without running `main`. */
export const selectFixtureAction = (label: string | undefined): FixtureAction => {
  if (label === '--prune') return { kind: 'prune' };
  const spec =
    label === 'large'
      ? LARGE_FIXTURE
      : label === 'medium'
        ? MEDIUM_FIXTURE
        : label === 'delta-chain'
          ? DELTA_CHAIN_FIXTURE
          : label === 'many-pack'
            ? MANY_PACK_FIXTURE
            : undefined;
  return spec === undefined ? { kind: 'usage' } : { kind: 'generate', spec };
};

const runGenerate = async (spec: FixtureSpec): Promise<void> => {
  const start = Date.now();
  const fixture = await ensureScaledFixture(spec);
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(
    `${spec.label} fixture ready in ${seconds}s\n` +
      `  path: ${fixture.cwd}\n` +
      `  HEAD: ${fixture.headCommitId}\n`,
  );
};

/** Rendering is the CLI's job, not the module's — `pruneFixtureCache` returns
 *  structured data only. Byte counts are logical bytes (sum of file sizes),
 *  not `du`'s block-rounded count, so say so rather than let a reader "fix"
 *  the number against `du`. */
const runPrune = async (): Promise<void> => {
  const report = await pruneFixtureCache();
  if (report.removed.length === 0 && report.failed.length === 0) {
    process.stdout.write(`nothing to prune under ${report.root}\n`);
    return;
  }
  for (const entry of report.removed) {
    process.stdout.write(`removed ${entry.path} (${entry.bytes} bytes)\n`);
  }
  const reclaimed = report.removed.reduce((total, entry) => total + entry.bytes, 0);
  process.stdout.write(
    `reclaimed ${reclaimed} logical bytes from ${report.removed.length} directories under ${report.root}\n`,
  );
  for (const failure of report.failed) {
    process.stderr.write(`could not remove ${failure.path}: ${failure.reason}\n`);
  }
  if (report.failed.length > 0) process.exit(1);
};

const main = async (): Promise<void> => {
  const action = selectFixtureAction(process.argv[2]);
  if (action.kind === 'usage') {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  if (action.kind === 'prune') {
    await runPrune();
    return;
  }
  await runGenerate(action.spec);
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
};

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

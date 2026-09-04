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
import { type PruneReport, pruneFixtureCache } from '../test/bench/support/fixture-prune.ts';

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

export interface PruneRendering {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Rendering is the CLI's job, not the module's — `pruneFixtureCache` returns
 * structured data only. Byte counts are logical bytes (sum of file sizes), not
 * `du`'s block-rounded count, so the wording says so rather than let a reader
 * "fix" the number against `du`. Exported so the three shapes are unit-tested.
 */
export const formatPruneReport = (report: PruneReport): PruneRendering => {
  if (report.removed.length === 0 && report.failed.length === 0) {
    return { stdout: `nothing to prune under ${report.root}\n`, stderr: '', exitCode: 0 };
  }
  const reclaimed = report.removed.reduce((total, entry) => total + entry.bytes, 0);
  const lines = report.removed.map((entry) => `removed ${entry.path} (${entry.bytes} bytes)\n`);
  const summary = `reclaimed ${reclaimed} logical bytes from ${report.removed.length} directories under ${report.root}\n`;
  const stderr = report.failed
    .map((failure) => `could not remove ${failure.path}: ${failure.reason}\n`)
    .join('');
  return { stdout: lines.join('') + summary, stderr, exitCode: report.failed.length > 0 ? 1 : 0 };
};

const runPrune = async (): Promise<void> => {
  const rendering = formatPruneReport(await pruneFixtureCache());
  process.stdout.write(rendering.stdout);
  process.stderr.write(rendering.stderr);
  // `exitCode`, never `process.exit`: both streams are pipes under `npm run`,
  // where a hard exit can truncate the diagnostics just written.
  process.exitCode = rendering.exitCode;
};

const main = async (): Promise<void> => {
  const action = selectFixtureAction(process.argv[2]);
  if (action.kind === 'usage') {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
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
    process.exitCode = 1;
  });
}

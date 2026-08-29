#!/usr/bin/env node
/**
 * Local A/B driver — runs the CI "Benchmark comparison" recipe
 * (`.github/workflows/ci.yml`'s `benchmark-compare` job) against two local
 * refs instead of a PR's base/head checkouts. Unlike `bench-check.ts`, which
 * scopes every comparison to `docs/perf/hot-paths.json`'s allowlist (a
 * CI-only scoping that silently drops `add`/`commit`/`merge`/`checkout`),
 * this driver reports every tsgit-scoped scenario the two trees share, so it
 * can A/B any command, not just the CI-picked hot set.
 *
 * Two worktrees, checked out detached at BASE_REF and HEAD_REF, share this
 * tree's `node_modules` (symlinked — both refs already share a lockfile, so
 * a fresh install buys nothing but time). Rounds alternate base/head so
 * runner drift (page-cache warming, thermal throttling, a noisy neighbour
 * arriving) lands on both sides instead of accruing to whichever one always
 * runs second, and each side is reduced by its fastest round via
 * `bestOfRounds` before the two are compared.
 *
 *   npm run bench:ab -- <base-ref> [head-ref] [rounds]
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bestOfRounds,
  type CompareResult,
  compareToBaseline,
  escapeCell,
  gatedEntries,
  resolveThresholdPct,
} from './bench-check.ts';
import { type RawReport, type SnapshotEntry, toSnapshotEntries } from './bench-to-snapshot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_DIR = 'test/bench';
const BENCH_FILE_SUFFIX = '.bench.ts';
const RAW_REPORT_RELATIVE = path.join('reports', 'benchmarks', 'raw.json');
const DEFAULT_ROUNDS = 3;
const PREWARM_LABELS = ['medium', 'delta-chain', 'many-pack'] as const;
const LARGE_PREWARM_LABEL = 'large';
const TSGIT_BENCH_LARGE_ENV_VAR = 'TSGIT_BENCH_LARGE';

export type Side = 'base' | 'head';

export interface RoundStep {
  readonly side: Side;
  readonly round: number;
}

/**
 * Files present in both worktrees only — a ref that adds or renames a bench
 * file must not hand its own side extra measured work the other side never
 * runs.
 */
export const intersectBenchFiles = (
  baseFiles: readonly string[],
  headFiles: readonly string[],
): readonly string[] => {
  const headSet = new Set(headFiles);
  return baseFiles.filter((file) => headSet.has(file));
};

/**
 * Alternates base, head, base, head, … for `rounds` rounds per side, so
 * runner drift is shared across both sides instead of accruing to whichever
 * one always runs second.
 */
export const planRounds = (rounds: number): readonly RoundStep[] =>
  Array.from({ length: rounds }, (_unused, i) => i + 1).flatMap((round) => [
    { side: 'base' as const, round },
    { side: 'head' as const, round },
  ]);

/** tsgit-scoped entries, unfiltered by `docs/perf/hot-paths.json` — the
 *  filter that makes `bench-check.ts` unusable for anything outside the
 *  CI-picked hot set. */
const toAbEntries = (raw: RawReport): readonly SnapshotEntry[] =>
  gatedEntries(toSnapshotEntries(raw));

/**
 * Pure comparison core: reduces each side's rounds to its fastest
 * observation per scenario, then compares. Takes parsed reports directly so
 * it needs no filesystem to test.
 */
export const compareAbRounds = (
  baseReports: readonly RawReport[],
  headReports: readonly RawReport[],
  thresholdPct: number,
): CompareResult => {
  const base = bestOfRounds(baseReports.map(toAbEntries));
  const current = bestOfRounds(headReports.map(toAbEntries));
  return compareToBaseline(base, current, { thresholdPct });
};

const formatMs = (ms: number | null): string => (ms === null ? '—' : ms.toFixed(2));

const formatDeltaPct = (deltaPct: number | null): string =>
  deltaPct === null ? 'n/a' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;

const renderRow = (row: CompareResult['rows'][number]): string =>
  `| ${[
    escapeCell(row.key),
    formatMs(row.baseMs),
    formatMs(row.currentMs),
    formatDeltaPct(row.deltaPct),
    row.verdict,
  ].join(' | ')} |`;

/**
 * Same absolute-column shape as `bench-check.ts`'s PR table — `Base (ms)`
 * and `Current (ms)` side by side, not just a delta — because a local run
 * has no baseline history to fall back on when the delta alone is
 * ambiguous.
 */
export const renderAbTable = (result: CompareResult, thresholdPct: number): string =>
  [
    '## Benchmark comparison (local A/B)',
    '',
    `> Threshold: ${thresholdPct}% (median-ms, best of alternated rounds, same-runner, advisory)`,
    '',
    '| Scenario | Base (ms) | Current (ms) | Delta | Verdict |',
    '|---|---|---|---|---|',
    ...result.rows.map(renderRow),
    '',
    result.failed ? 'regression flagged — advisory' : 'no regression',
  ].join('\n');

// ---------------------------------------------------------------------------
// Worktree/spawn shell. Thin by design: every decision worth a unit test
// lives in the pure helpers above.

const addWorktree = async (ref: string, side: Side): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-bench-ab-${side}-`));
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: ROOT, stdio: 'inherit' });
  await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
};

const removeWorktree = (dir: string): void => {
  execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'inherit' });
};

const prewarmLabelsFor = (env: NodeJS.ProcessEnv): readonly string[] =>
  env[TSGIT_BENCH_LARGE_ENV_VAR] === undefined
    ? PREWARM_LABELS
    : [...PREWARM_LABELS, LARGE_PREWARM_LABEL];

const preWarmFixtures = (worktreeDir: string): void => {
  for (const label of prewarmLabelsFor(process.env)) {
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'tooling/gen-bench-fixture.ts', label],
      { cwd: worktreeDir, stdio: 'inherit' },
    );
  }
};

const listBenchFiles = async (worktreeDir: string): Promise<readonly string[]> => {
  const entries = await readdir(path.join(worktreeDir, BENCH_DIR));
  return entries
    .filter((name) => name.endsWith(BENCH_FILE_SUFFIX))
    .map((name) => path.join(BENCH_DIR, name))
    .sort();
};

const runRound = async (
  worktreeDir: string,
  files: readonly string[],
  reportPath: string,
): Promise<void> => {
  execFileSync(
    path.join(worktreeDir, 'node_modules', '.bin', 'vitest'),
    ['bench', '--run', '--config', 'vitest.bench.config.ts', ...files],
    { cwd: worktreeDir, stdio: 'inherit' },
  );
  await copyFile(path.join(worktreeDir, RAW_REPORT_RELATIVE), reportPath);
};

const readRawReport = async (filePath: string): Promise<RawReport> =>
  JSON.parse(await readFile(filePath, 'utf8')) as RawReport;

interface Args {
  readonly baseRef: string;
  readonly headRef: string;
  readonly rounds: number;
}

const parseArgs = (argv: readonly string[]): Args => {
  const baseRef = argv[2];
  const headRef = argv[3] ?? 'HEAD';
  const rounds = argv[4] !== undefined ? Number(argv[4]) : DEFAULT_ROUNDS;
  if (baseRef === undefined || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error('usage: bench-ab <base-ref> [head-ref] [rounds]');
  }
  return { baseRef, headRef, rounds };
};

const main = async (): Promise<void> => {
  const { baseRef, headRef, rounds } = parseArgs(process.argv);

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-ab-reports-'));
  const worktrees: Record<Side, string> = {
    base: await addWorktree(baseRef, 'base'),
    head: await addWorktree(headRef, 'head'),
  };

  try {
    for (const dir of Object.values(worktrees)) preWarmFixtures(dir);

    const files = intersectBenchFiles(
      await listBenchFiles(worktrees.base),
      await listBenchFiles(worktrees.head),
    );
    if (files.length === 0) {
      throw new Error('no bench files shared between base and head — nothing to compare');
    }

    const reportPaths: Record<Side, string[]> = { base: [], head: [] };
    for (const step of planRounds(rounds)) {
      const reportPath = path.join(tmpRoot, `${step.side}-${step.round}.json`);
      await runRound(worktrees[step.side], files, reportPath);
      reportPaths[step.side].push(reportPath);
    }

    const [baseReports, headReports] = await Promise.all([
      Promise.all(reportPaths.base.map(readRawReport)),
      Promise.all(reportPaths.head.map(readRawReport)),
    ]);

    const thresholdPct = resolveThresholdPct();
    const result = compareAbRounds(baseReports, headReports, thresholdPct);
    process.stdout.write(`${renderAbTable(result, thresholdPct)}\n`);
    process.exitCode = result.failed ? 1 : 0;
  } finally {
    for (const dir of Object.values(worktrees)) removeWorktree(dir);
    await rm(tmpRoot, { recursive: true, force: true });
  }
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

#!/usr/bin/env node
/**
 * Compares two same-runner benchmark snapshots (base vs head) on a
 * per-scenario median-ms basis, scoped to `tsgit`-named entries only
 * (isomorphic-git rows are dropped). A row regresses when the head is
 * more than `policy.thresholdPct` percent slower than the base — the
 * comparison is asymmetric, so improvements never flag. The default
 * threshold is `DEFAULT_THRESHOLD_PCT`; callers may override it (e.g. via
 * the `REGRESSION_THRESHOLD` env var, resolved by the CLI wrapper).
 */
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RawReport, type SnapshotEntry, toSnapshotEntries } from './bench-to-snapshot.ts';

export const DEFAULT_THRESHOLD_PCT = 10;

const TSGIT_KEY_SUFFIX = ' > tsgit';

export const gatedEntries = (entries: readonly SnapshotEntry[]): readonly SnapshotEntry[] =>
  entries.filter((entry) => entry.name.endsWith(TSGIT_KEY_SUFFIX));

type Verdict = 'pass' | 'regress' | 'new' | 'missing';

export interface CompareRow {
  readonly key: string;
  readonly baseMs: number | null;
  readonly currentMs: number | null;
  readonly deltaPct: number | null;
  readonly verdict: Verdict;
}

export interface CompareResult {
  readonly rows: readonly CompareRow[];
  readonly failed: boolean;
}

const classifyRow = (
  key: string,
  baseMs: number | undefined,
  currentMs: number | undefined,
  thresholdPct: number,
): CompareRow => {
  if (baseMs === undefined) {
    return { key, baseMs: null, currentMs: currentMs ?? null, deltaPct: null, verdict: 'new' };
  }
  if (currentMs === undefined) {
    return { key, baseMs, currentMs: null, deltaPct: null, verdict: 'missing' };
  }
  if (baseMs === 0) {
    return { key, baseMs, currentMs, deltaPct: null, verdict: 'missing' };
  }
  const deltaPct = ((currentMs - baseMs) / baseMs) * 100;
  const verdict: Verdict = deltaPct > thresholdPct ? 'regress' : 'pass';
  return { key, baseMs, currentMs, deltaPct, verdict };
};

export const compareToBaseline = (
  base: readonly SnapshotEntry[],
  current: readonly SnapshotEntry[],
  policy: { readonly thresholdPct: number },
): CompareResult => {
  const baseByKey = new Map(base.map((entry) => [entry.name, entry.value]));
  const currentByKey = new Map(current.map((entry) => [entry.name, entry.value]));
  const keys = [...new Set([...baseByKey.keys(), ...currentByKey.keys()])].sort();

  const rows = keys.map((key) =>
    classifyRow(key, baseByKey.get(key), currentByKey.get(key), policy.thresholdPct),
  );
  const failed = rows.some((row) => row.verdict === 'regress');

  return { rows, failed };
};

const PR_COMMENT_PATH = '/tmp/bench-comment.md';

const readReport = async (filePath: string): Promise<readonly SnapshotEntry[]> =>
  gatedEntries(toSnapshotEntries(JSON.parse(await readFile(filePath, 'utf8')) as RawReport));

const resolveThresholdPct = (): number => {
  const raw = process.env.REGRESSION_THRESHOLD ?? String(DEFAULT_THRESHOLD_PCT);
  const thresholdPct = Number(raw);
  if (Number.isNaN(thresholdPct)) {
    throw new Error(`REGRESSION_THRESHOLD must be a number, got: ${raw}`);
  }
  return thresholdPct;
};

const formatMs = (ms: number | null): string => (ms === null ? '—' : ms.toFixed(2));

const formatDeltaPct = (deltaPct: number | null): string =>
  deltaPct === null ? 'n/a' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;

const renderRow = (row: CompareRow): string => {
  const cells = [
    row.key,
    formatMs(row.baseMs),
    formatMs(row.currentMs),
    formatDeltaPct(row.deltaPct),
    row.verdict,
  ];
  return `| ${cells.join(' | ')} |`;
};

const renderTable = (result: CompareResult, thresholdPct: number): string =>
  [
    '## Benchmark comparison (same runner)',
    '',
    `> Threshold: ${thresholdPct}% (median-ms, same-runner, advisory)`,
    '',
    '| Scenario | Base (ms) | Current (ms) | Delta | Verdict |',
    '|---|---|---|---|---|',
    ...result.rows.map(renderRow),
    '',
    result.failed ? 'regression flagged — advisory' : 'no regression',
  ].join('\n');

const emit = async (comment: string): Promise<void> => {
  process.stdout.write(`${comment}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `\n${comment}\n`);
  await writeFile(PR_COMMENT_PATH, comment, 'utf8');
};

const main = async (): Promise<void> => {
  const basePath = process.argv[2];
  const headPath = process.argv[3];
  if (basePath === undefined || headPath === undefined) {
    throw new Error('usage: bench-check <base-raw.json> <head-raw.json>');
  }

  const [base, current] = await Promise.all([readReport(basePath), readReport(headPath)]);
  if (base.length === 0 && current.length === 0) {
    await emit('No benchmark data to compare.');
    process.exit(0);
  }

  const thresholdPct = resolveThresholdPct();
  const result = compareToBaseline(base, current, { thresholdPct });
  await emit(renderTable(result, thresholdPct));
  process.exit(result.failed ? 1 : 0);
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

#!/usr/bin/env node
/**
 * Compares same-runner benchmark snapshots (base vs head) on a per-scenario
 * median-ms basis. Each side may be measured over several alternated rounds
 * and is reduced by `bestOfRounds` before the comparison, so the verdict
 * reflects the code rather than whichever side happened to run on a busier
 * slice of the runner. Scoped to `tsgit`-named entries only
 * (isomorphic-git rows are dropped). A row regresses when the head is
 * more than `policy.thresholdPct` percent slower than the base — the
 * comparison is asymmetric, so improvements never flag. The default
 * threshold is `DEFAULT_THRESHOLD_PCT`; callers may override it (e.g. via
 * the `REGRESSION_THRESHOLD` env var, resolved by the CLI wrapper).
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RawReport, type SnapshotEntry, toSnapshotEntries } from './bench-to-snapshot.ts';

export const DEFAULT_THRESHOLD_PCT = 10;

const TSGIT_KEY_SUFFIX = ' > tsgit';

export const gatedEntries = (entries: readonly SnapshotEntry[]): readonly SnapshotEntry[] =>
  entries.filter((entry) => entry.name.endsWith(TSGIT_KEY_SUFFIX));

const BENCH_KEY_SEPARATOR = ' > ';
const BENCH_FILE_SUFFIX = '.bench.ts';

export const operationOf = (key: string): string => {
  const firstSegment = key.split(BENCH_KEY_SEPARATOR)[0] ?? '';
  const basename = path.basename(firstSegment);
  return basename.endsWith(BENCH_FILE_SUFFIX) ? basename.slice(0, -BENCH_FILE_SUFFIX.length) : '';
};

export const hotGatedEntries = (
  entries: readonly SnapshotEntry[],
  hot: readonly string[],
): readonly SnapshotEntry[] =>
  gatedEntries(entries).filter((entry) => hot.includes(operationOf(entry.name)));

export const parseHotOperations = (parsed: unknown): readonly string[] => {
  const hotOperations = (parsed as { hotOperations?: unknown } | null)?.hotOperations;
  const isValid =
    Array.isArray(hotOperations) && hotOperations.every((op) => typeof op === 'string');
  if (!isValid) {
    throw new Error('hot-paths.json: "hotOperations" must be an array of operation strings');
  }
  return hotOperations;
};

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
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(currentMs)) {
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

const readReport = async (
  filePath: string,
  hot: readonly string[],
): Promise<readonly SnapshotEntry[]> =>
  hotGatedEntries(
    toSnapshotEntries(JSON.parse(await readFile(filePath, 'utf8')) as RawReport),
    hot,
  );

/**
 * Reduces the rounds measured for ONE side to a single entry per scenario,
 * keeping the FASTEST observation of each.
 *
 * Minimum rather than mean or median because benchmark noise on a shared
 * runner is one-directional: a descheduled process, a cold page, a noisy
 * neighbour's I/O all ADD time and none subtract it. The fastest round is
 * therefore the observation least contaminated by the runner, and reducing
 * both sides the same way is what turns an alternated A/B into a comparison
 * of the code rather than of the machine's mood.
 *
 * A scenario missing from some rounds is still reported from the rounds that
 * do have it; one missing from every round stays absent, so
 * `compareToBaseline` can still call it `new` or `missing`.
 */
export const bestOfRounds = (
  rounds: readonly (readonly SnapshotEntry[])[],
): readonly SnapshotEntry[] => {
  const fastest = new Map<string, SnapshotEntry>();
  for (const round of rounds) {
    for (const entry of round) {
      const seen = fastest.get(entry.name);
      if (seen === undefined || entry.value < seen.value) fastest.set(entry.name, entry);
    }
  }
  return [...fastest.values()];
};

export const resolveThresholdPct = (
  rawEnv: string | undefined = process.env.REGRESSION_THRESHOLD,
): number => {
  const raw = rawEnv === undefined || rawEnv.trim() === '' ? String(DEFAULT_THRESHOLD_PCT) : rawEnv;
  const thresholdPct = Number(raw);
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    throw new Error(`REGRESSION_THRESHOLD must be a positive finite number, got: ${raw}`);
  }
  return thresholdPct;
};

const formatMs = (ms: number | null): string => (ms === null ? '—' : ms.toFixed(2));

const formatDeltaPct = (deltaPct: number | null): string =>
  deltaPct === null ? 'n/a' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;

// The scenario name comes from developer-authored bench files but is PR-influenceable
// and renders into a posted PR comment: wrap it as an inline-code span and escape pipes
// so a crafted name cannot break the markdown table or autolink an @mention / #issue-ref.
// The code fence is one backtick longer than the longest run inside the value (and padded
// with a space when the value holds a backtick), per the GFM code-span rule, so an embedded
// backtick cannot close the span early and re-expose the content to markdown.
export const escapeCell = (value: string): string => {
  const escaped = value.replace(/\|/g, '\\|');
  const longestBacktickRun = Math.max(0, ...[...escaped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longestBacktickRun + 1);
  const pad = escaped.includes('`') ? ' ' : '';
  return `${fence}${pad}${escaped}${pad}${fence}`;
};

const renderRow = (row: CompareRow): string => {
  const cells = [
    escapeCell(row.key),
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
    `> Threshold: ${thresholdPct}% (median-ms, best of alternated rounds, same-runner, advisory)`,
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

/** Each side is one comma-separated list of round reports, so a single-round
 *  invocation stays exactly the old one-path-per-side call. */
const splitRounds = (arg: string): readonly string[] =>
  arg
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

const main = async (): Promise<void> => {
  const baseArg = process.argv[2];
  const headArg = process.argv[3];
  if (baseArg === undefined || headArg === undefined) {
    throw new Error('usage: bench-check <base-raw.json[,...]> <head-raw.json[,...]>');
  }
  const basePaths = splitRounds(baseArg);
  const headPaths = splitRounds(headArg);
  if (basePaths.length === 0 || headPaths.length === 0) {
    throw new Error('usage: bench-check <base-raw.json[,...]> <head-raw.json[,...]>');
  }

  const REGISTRY = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    'docs',
    'perf',
    'hot-paths.json',
  );
  const hot = parseHotOperations(JSON.parse(await readFile(REGISTRY, 'utf8')));

  const [baseRounds, currentRounds] = await Promise.all([
    Promise.all(basePaths.map((filePath) => readReport(filePath, hot))),
    Promise.all(headPaths.map((filePath) => readReport(filePath, hot))),
  ]);
  const base = bestOfRounds(baseRounds);
  const current = bestOfRounds(currentRounds);
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

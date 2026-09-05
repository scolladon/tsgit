#!/usr/bin/env node
/**
 * Reads reports/benchmarks/raw.json (vitest bench output) and emits a markdown
 * summary table to reports/benchmarks/summary.md. Run via `npm run bench:summary`
 * after `npm run test:bench`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'reports', 'benchmarks', 'raw.json');
const OUT = path.join(ROOT, 'reports', 'benchmarks', 'summary.md');

interface BenchEntry {
  readonly name: string;
  readonly hz?: number;
  readonly mean?: number;
  readonly median?: number;
  readonly rme: number;
}

export interface BenchGroup {
  readonly fullName: string;
  readonly benchmarks: ReadonlyArray<BenchEntry>;
}

interface BenchFile {
  readonly filepath: string;
  readonly groups: ReadonlyArray<BenchGroup>;
}

export interface RawReport {
  readonly files: ReadonlyArray<BenchFile>;
}

/** The three impure facts `main()` alone is allowed to read (clock, `process`,
 * `os`) — a fixed value here keeps {@link renderSummary} deterministic. */
export interface SummaryEnvironment {
  readonly generatedAt: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly cpuModel: string;
}

/** A {@link BenchEntry} narrowed to the fields a rendered cell needs, once it
 * has passed the measured predicate below. */
interface MeasuredBenchEntry {
  readonly value: number;
  readonly hz: number;
  readonly rme: number;
}

const scenarioName = (fullName: string): string => {
  const parts = fullName.split(' > ');
  return parts[parts.length - 1] ?? fullName;
};

const findByName = (group: BenchGroup, name: string): BenchEntry | undefined =>
  group.benchmarks.find((bench) => bench.name === name);

const formatMs = (value: number): string => `${value.toFixed(3)} ms`;
const formatHz = (value: number): string => `${value.toFixed(0)}/s`;
const formatSpeedup = (a: number, b: number): string => {
  if (b === 0) return 'n/a';
  const ratio = a / b;
  return `${ratio.toFixed(2)}×`;
};

/**
 * An entry counts as measured when `median ?? mean` is a number AND `hz` is
 * a number — vitest emits those together (a full result), never one without
 * the other. A benchmark that threw during warmup yields neither.
 */
const asMeasured = (entry: BenchEntry | undefined): MeasuredBenchEntry | undefined => {
  if (entry === undefined) return undefined;
  const value = entry.median ?? entry.mean;
  if (typeof value !== 'number' || typeof entry.hz !== 'number') return undefined;
  return { value, hz: entry.hz, rme: entry.rme };
};

const formatCell = (entry: MeasuredBenchEntry): string =>
  `${formatMs(entry.value)} (${formatHz(entry.hz)}, ±${entry.rme.toFixed(2)}%)`;

export const renderRow = (group: BenchGroup): string => {
  const scenario = scenarioName(group.fullName);
  const tsgit = asMeasured(findByName(group, 'tsgit'));
  if (tsgit === undefined) {
    return `| ${scenario} | _missing entry_ | _missing entry_ | n/a |`;
  }
  const iso = asMeasured(findByName(group, 'isomorphic-git'));
  if (iso === undefined) {
    return `| ${scenario} | ${formatCell(tsgit)} | — | n/a |`;
  }
  const speedup = formatSpeedup(iso.value, tsgit.value);
  return `| ${scenario} | ${formatCell(tsgit)} | ${formatCell(iso)} | ${speedup} |`;
};

export const renderSummary = (raw: RawReport, environment: SummaryEnvironment): string => {
  const groups = raw.files.flatMap((file) => file.groups);
  const lines: string[] = [
    '# Benchmark results',
    '',
    `Generated ${environment.generatedAt} on \`${environment.platform}-${environment.arch}\` (Node ${environment.nodeVersion}, ${environment.cpuModel}).`,
    '',
    '| Scenario | tsgit | isomorphic-git | speedup (tsgit faster) |',
    '|---|---|---|---|',
    ...groups.map(renderRow),
    '',
    '> _speedup > 1×_ means tsgit beat isomorphic-git on median runtime. Raw',
    '> data in `reports/benchmarks/raw.json` includes p75/p99/RME and per-run',
    '> sample counts. GitHub Actions runners introduce ±20% variance — trust',
    '> direction more than absolute numbers. The speedup column applies to',
    '> paired rows only.',
    '',
  ];
  return lines.join('\n');
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === url.fileURLToPath(import.meta.url);
};

const main = async (): Promise<void> => {
  const raw = JSON.parse(await readFile(RAW, 'utf8')) as RawReport;
  const environment: SummaryEnvironment = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpuModel: os.cpus()[0]?.model ?? 'unknown CPU',
  };
  await writeFile(OUT, renderSummary(raw, environment), 'utf8');
  process.stdout.write(`Wrote ${OUT}\n`);
};

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

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

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'reports', 'benchmarks', 'raw.json');
const OUT = path.join(ROOT, 'reports', 'benchmarks', 'summary.md');

interface BenchEntry {
  readonly name: string;
  readonly hz: number;
  readonly mean: number;
  readonly median?: number;
  readonly p99: number;
  readonly rme: number;
}

interface BenchGroup {
  readonly fullName: string;
  readonly benchmarks: ReadonlyArray<BenchEntry>;
}

interface BenchFile {
  readonly filepath: string;
  readonly groups: ReadonlyArray<BenchGroup>;
}

interface RawReport {
  readonly files: ReadonlyArray<BenchFile>;
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

const renderRow = (group: BenchGroup): string => {
  const scenario = scenarioName(group.fullName);
  const tsgit = findByName(group, 'tsgit');
  const iso = findByName(group, 'isomorphic-git');
  if (tsgit === undefined || iso === undefined) {
    return `| ${scenario} | _missing entry_ | _missing entry_ | n/a |`;
  }
  const tsgitMean = tsgit.median ?? tsgit.mean;
  const isoMean = iso.median ?? iso.mean;
  const speedup = formatSpeedup(isoMean, tsgitMean);
  return `| ${scenario} | ${formatMs(tsgitMean)} (${formatHz(tsgit.hz)}, ±${tsgit.rme.toFixed(2)}%) | ${formatMs(isoMean)} (${formatHz(iso.hz)}, ±${iso.rme.toFixed(2)}%) | ${speedup} |`;
};

const main = async (): Promise<void> => {
  const raw = JSON.parse(await readFile(RAW, 'utf8')) as RawReport;
  const groups = raw.files.flatMap((file) => file.groups);
  const lines: string[] = [
    '# Benchmark results',
    '',
    `Generated ${new Date().toISOString()} on \`${process.platform}-${process.arch}\` (Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}).`,
    '',
    '| Scenario | tsgit | isomorphic-git | speedup (tsgit faster) |',
    '|---|---|---|---|',
    ...groups.map(renderRow),
    '',
    '> _speedup > 1×_ means tsgit beat isomorphic-git on median runtime. Raw',
    '> data in `reports/benchmarks/raw.json` includes p75/p99/RME and per-run',
    '> sample counts. GitHub Actions runners introduce ±20% variance — trust',
    '> direction more than absolute numbers.',
    '',
  ];
  await writeFile(OUT, lines.join('\n'), 'utf8');
  process.stdout.write(`Wrote ${OUT}\n`);
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

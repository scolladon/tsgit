#!/usr/bin/env node
/**
 * Converts reports/benchmarks/raw.json (vitest bench schema) into the
 * `customSmallerIsBetter` schema `benchmark-action/github-action-benchmark@v1`
 * consumes, written to reports/benchmarks/snapshot.json.
 *
 * See docs/adr/056-benchmark-snapshot-converter-schema.md — median-ms metric,
 * `<group> > <bench>` naming. This module declares its own minimal view of
 * the raw.json schema rather than sharing types with bench-summarize.ts.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface RawBenchmark {
  readonly name: string;
  readonly mean: number;
  readonly median?: number;
}

interface RawGroup {
  readonly fullName: string;
  readonly benchmarks: ReadonlyArray<RawBenchmark>;
}

interface RawFile {
  readonly groups: ReadonlyArray<RawGroup>;
}

export interface RawReport {
  readonly files: ReadonlyArray<RawFile>;
}

interface SnapshotEntry {
  readonly name: string;
  readonly unit: 'ms';
  readonly value: number;
}

/**
 * Flattens every (group, benchmark) pair into one snapshot entry. `value` is
 * the median runtime (fallback: mean) in ms — smaller is better, matching
 * `customSmallerIsBetter`.
 */
export const toSnapshotEntries = (raw: RawReport): SnapshotEntry[] => {
  const entries: SnapshotEntry[] = [];
  for (const file of raw.files) {
    for (const group of file.groups) {
      for (const bench of group.benchmarks) {
        entries.push({
          name: `${group.fullName} > ${bench.name}`,
          unit: 'ms',
          value: bench.median ?? bench.mean,
        });
      }
    }
  }
  return entries;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'reports', 'benchmarks', 'raw.json');
const OUT = path.join(ROOT, 'reports', 'benchmarks', 'snapshot.json');

const main = async (): Promise<void> => {
  const raw = JSON.parse(await readFile(RAW, 'utf8')) as RawReport;
  const entries = toSnapshotEntries(raw);
  await writeFile(OUT, JSON.stringify(entries, null, 2), 'utf8');
  process.stdout.write(`Wrote ${entries.length} snapshot entries to ${OUT}\n`);
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

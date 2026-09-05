#!/usr/bin/env node
/**
 * Converts reports/benchmarks/raw.json (vitest bench schema) into the
 * `customSmallerIsBetter` schema `benchmark-action/github-action-benchmark@v1`
 * consumes, written to reports/benchmarks/snapshot.json.
 *
 * The tracked metric is median runtime in ms (smaller is better) and entries
 * are named `<group> > <bench>`. This module declares its own minimal view of
 * the raw.json schema rather than sharing types with bench-summarize.ts.
 *
 * `toSnapshotEntries` returns the plain parse result — no Node-version
 * metadata attached. Only the published (gh-pages) path needs that metadata,
 * so `withNodeVersion` stamps it on separately: every entry carries the
 * resolved Node version (never the CI alias, which is constant) in `extra`,
 * so a step in the `gh-pages` trend series can be attributed to a runtime
 * change rather than misread as a regression.
 *
 * The publish path refuses a value-less entry by name before writing
 * anything; `bench-check.ts`, the other consumer of `toSnapshotEntries`,
 * deliberately does not inherit that refusal.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOLVED_NODE_VERSION_ENV_VAR = 'RESOLVED_NODE_VERSION';

interface RawBenchmark {
  readonly name: string;
  readonly mean?: number;
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

export interface SnapshotEntry {
  readonly name: string;
  readonly unit: 'ms';
  readonly value: number;
}

/** A {@link SnapshotEntry} stamped with the resolved Node version — the
 * shape the `gh-pages` trend series (and only that path) consumes. */
export interface StampedSnapshotEntry extends SnapshotEntry {
  readonly extra: string;
}

/** A benchmark's tracked metric — median runtime, falling back to mean — or
 * `undefined` when vitest emitted neither (a benchmark that threw in warmup). */
const benchmarkValue = (bench: RawBenchmark): number | undefined => bench.median ?? bench.mean;

/** The `"<group fullName> > <bench name>"` key shared by every snapshot entry
 * and by {@link assertEveryBenchmarkValued}'s offender list. */
const benchmarkKey = (group: RawGroup, bench: RawBenchmark): string =>
  `${group.fullName} > ${bench.name}`;

/**
 * Flattens every (group, benchmark) pair into one snapshot entry, skipping a
 * benchmark that yields no value. `value` is the median runtime (fallback:
 * mean) in ms — smaller is better, matching `customSmallerIsBetter`.
 */
export const toSnapshotEntries = (raw: RawReport): SnapshotEntry[] =>
  raw.files.flatMap((file) =>
    file.groups.flatMap((group) =>
      group.benchmarks.flatMap((bench) => {
        const value = benchmarkValue(bench);
        return value === undefined
          ? []
          : [{ name: benchmarkKey(group, bench), unit: 'ms' as const, value }];
      }),
    ),
  );

/**
 * Refuses a parsed report that holds a benchmark carrying neither `median`
 * nor `mean`, naming every offender as `"<group fullName> > <bench name>"`.
 * Returns the report unchanged (same reference) when every benchmark yields
 * a value. Placed beside `toSnapshotEntries` rather than inside it: the
 * comparison tool (`bench-check.ts`) also converts a report and deliberately
 * does not inherit this refusal.
 */
export const assertEveryBenchmarkValued = (raw: RawReport): RawReport => {
  const offenders = raw.files.flatMap((file) =>
    file.groups.flatMap((group) =>
      group.benchmarks
        .filter((bench) => benchmarkValue(bench) === undefined)
        .map((bench) => benchmarkKey(group, bench)),
    ),
  );
  if (offenders.length > 0) {
    throw new Error(
      `Benchmark(s) with no value (neither median nor mean): ${offenders.join(', ')}`,
    );
  }
  return raw;
};

/** Stamps every entry with the resolved Node version, producing the shape
 * the `gh-pages` publish path writes. */
export const withNodeVersion = (
  entries: readonly SnapshotEntry[],
  resolvedNodeVersion: string,
): StampedSnapshotEntry[] => entries.map((entry) => ({ ...entry, extra: resolvedNodeVersion }));

/**
 * Reads and validates the resolved Node version the CI runner reported.
 * Refuses (rather than silently emitting useless metadata) when the variable
 * is missing, empty, or still alias-shaped — a resolved version never
 * contains `*` or `/`.
 */
export const resolveNodeVersion = (env: NodeJS.ProcessEnv): string => {
  const version = env[RESOLVED_NODE_VERSION_ENV_VAR];
  if (!version) {
    throw new Error(
      `${RESOLVED_NODE_VERSION_ENV_VAR} is required (the resolved Node version for this run) but was not set`,
    );
  }
  if (version.includes('*') || version.includes('/')) {
    throw new Error(
      `${RESOLVED_NODE_VERSION_ENV_VAR} must be a resolved Node version, not an alias: "${version}"`,
    );
  }
  return version;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'reports', 'benchmarks', 'raw.json');
const OUT = path.join(ROOT, 'reports', 'benchmarks', 'snapshot.json');

const main = async (): Promise<void> => {
  const resolvedNodeVersion = resolveNodeVersion(process.env);
  const raw = assertEveryBenchmarkValued(JSON.parse(await readFile(RAW, 'utf8')) as RawReport);
  const entries = withNodeVersion(toSnapshotEntries(raw), resolvedNodeVersion);
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

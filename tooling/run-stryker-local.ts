#!/usr/bin/env node
/**
 * Chunked whole-codebase Stryker sweep for local development.
 *
 * A single `stryker run` over the full tree instruments ~31k mutants and then
 * crashes serialising the perTest coverage matrix (`RangeError: Invalid string
 * length` — the JSON exceeds V8's max string length). So this runner splits the
 * mutate universe into file-count chunks, runs `stryker run --incremental
 * --mutate <chunk>` for each, and aggregates every chunk's surviving mutants
 * into one report. `--incremental` means an edit-and-re-run only re-tests the
 * changed files, so the "adjust" loop stays cheap after the first full pass.
 *
 * Usage: `npm run test:mutation:local [-- --chunk-size <n>]` (default 20 files).
 *
 * Per-chunk staleness is handled by only crediting a chunk with report entries
 * for the files IT mutated — a chunk that crashes leaves the previous chunk's
 * report on disk, but none of the crashed chunk's own files appear in it, so it
 * contributes nothing and is counted as a failed chunk instead.
 */
import { spawn } from 'node:child_process';
import { globSync, readFileSync, rmSync } from 'node:fs';
import * as process from 'node:process';
import { pathToFileURL } from 'node:url';

export interface SpawnedProcess {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: { stdio?: 'inherit' },
) => SpawnedProcess;

export interface MutantEntry {
  readonly status: string;
  readonly mutatorName: string;
  readonly location: { readonly start: { readonly line: number; readonly column: number } };
  readonly replacement?: string;
}

export interface MutationReport {
  readonly files: Readonly<Record<string, { readonly mutants: readonly MutantEntry[] }>>;
}

export interface LocalSweepOptions {
  readonly argv: readonly string[];
  readonly files: readonly string[];
  readonly spawn: SpawnLike;
  /**
   * Deletes the Stryker JSON report before a chunk runs. A chunk that crashes
   * (or fails to spawn) then leaves no report, so it is credited nothing rather
   * than picking up a stale report that still lists its files from an earlier
   * full run.
   */
  readonly resetReport: () => void;
  /** Reads the Stryker JSON report written after the just-finished chunk. */
  readonly readReport: () => MutationReport | null;
  readonly stdout: (line: string) => void;
}

export interface SweepResult {
  readonly exitCode: number;
  readonly survivorsByFile: ReadonlyMap<string, readonly MutantEntry[]>;
  readonly chunksRun: number;
  readonly failedChunks: number;
}

const DEFAULT_CHUNK_SIZE = 20;
const SURVIVING_STATUSES = new Set(['Survived', 'NoCoverage']);

const parseChunkSize = (argv: readonly string[]): number => {
  const index = argv.indexOf('--chunk-size');
  if (index === -1) return DEFAULT_CHUNK_SIZE;
  const parsed = Number(argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_CHUNK_SIZE;
  return parsed;
};

// `--concurrency <n>` overrides the Stryker config's scheduled value for this
// sweep — the config resolves concurrency once at load and cannot be re-tuned
// per run, so the sweep passes it through to each chunk's `stryker run`.
const parseConcurrency = (argv: readonly string[]): number | null => {
  const index = argv.indexOf('--concurrency');
  if (index === -1) return null;
  const parsed = Number(argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const spawnChunk = (
  spawnLike: SpawnLike,
  mutateList: string,
  concurrency: number | null,
): Promise<number> =>
  new Promise<number>((resolve) => {
    const concurrencyArgs = concurrency === null ? [] : ['--concurrency', String(concurrency)];
    const child = spawnLike(
      'stryker',
      ['run', '--incremental', ...concurrencyArgs, '--mutate', mutateList],
      { stdio: 'inherit' },
    );
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

export const runStrykerLocalSweep = async (opts: LocalSweepOptions): Promise<SweepResult> => {
  const chunkSize = parseChunkSize(opts.argv);
  const concurrency = parseConcurrency(opts.argv);
  const chunks = chunk(opts.files, chunkSize);
  const survivorsByFile = new Map<string, readonly MutantEntry[]>();
  let failedChunks = 0;

  const at = concurrency === null ? '' : ` at concurrency ${concurrency}`;
  opts.stdout(
    `Sweeping ${opts.files.length} file(s) in ${chunks.length} chunk(s) of ${chunkSize}${at}`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const files = chunks[i] ?? [];
    opts.stdout(`[chunk ${i + 1}/${chunks.length}] mutating ${files.length} file(s)`);
    opts.resetReport();
    await spawnChunk(opts.spawn, files.join(','), concurrency);

    const report = opts.readReport();
    const covered = files.filter((file) => report?.files[file] !== undefined);
    if (covered.length === 0) {
      failedChunks += 1;
      opts.stdout(`[chunk ${i + 1}/${chunks.length}] no report entries — chunk failed`);
      continue;
    }
    for (const file of covered) {
      const survivors = (report?.files[file]?.mutants ?? []).filter((mutant) =>
        SURVIVING_STATUSES.has(mutant.status),
      );
      if (survivors.length > 0) survivorsByFile.set(file, survivors);
    }
  }

  const total = [...survivorsByFile.values()].reduce((sum, list) => sum + list.length, 0);
  opts.stdout(`\n=== ${total} surviving mutant(s) across ${survivorsByFile.size} file(s) ===`);
  for (const [file, survivors] of survivorsByFile) {
    opts.stdout(`\n${file} (${survivors.length})`);
    for (const mutant of survivors) {
      const where = `L${mutant.location.start.line}:${mutant.location.start.column}`;
      opts.stdout(`  ${where}  ${mutant.mutatorName}  [${mutant.status}]`);
    }
  }
  if (failedChunks > 0) {
    opts.stdout(`\n⚠ ${failedChunks} chunk(s) produced no report — re-run with a smaller --chunk-size`);
  }

  return {
    exitCode: failedChunks > 0 ? 1 : 0,
    survivorsByFile,
    chunksRun: chunks.length,
    failedChunks,
  };
};

const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
};

// The mutate universe mirrors stryker.config.mjs `mutate` (browser adapter and
// barrels/type-defs excluded — they carry no mutants worth sweeping).
const discoverMutateUniverse = (): string[] =>
  globSync('src/**/*.ts')
    .filter(
      (file) =>
        !file.endsWith('.d.ts') &&
        !file.endsWith('/index.ts') &&
        !file.startsWith('src/adapters/browser/'),
    )
    .sort();

const REPORT_PATH = 'reports/mutation/mutation-report.json';

const readReportFile = (): MutationReport | null => {
  try {
    return JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as MutationReport;
  } catch {
    return null;
  }
};

const resetReportFile = (): void => rmSync(REPORT_PATH, { force: true });

const nodeSpawn: SpawnLike = (command, args, options) => spawn(command, [...args], options ?? {});

// `--files a.ts,b.ts` restricts the sweep to a subset (targeted re-runs);
// otherwise the whole mutate universe is swept.
const parseFilesOverride = (argv: readonly string[]): string[] | null => {
  const index = argv.indexOf('--files');
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.length === 0) return null;
  return value.split(',').filter((file) => file.length > 0);
};

// `--bucket <name>` sweeps one budget layer at a time (the 26.12 "bucket by
// bucket" flow). The predicates form a COMPLETE partition of the mutate
// universe — every file lands in exactly one bucket — so the union of the five
// buckets equals the whole-tree sweep with no orphaned file.
export const BUCKET_PREDICATES: Readonly<Record<string, (file: string) => boolean>> = {
  domain: (file) => file.startsWith('src/domain/'),
  application: (file) =>
    file.startsWith('src/application/') ||
    file === 'src/repository.ts' ||
    file.startsWith('src/repository/') ||
    file === 'src/dispose-adapters.ts',
  adapters: (file) => file.startsWith('src/adapters/') || file === 'src/adapter-detect.ts',
  infra: (file) =>
    file.startsWith('src/operators/') ||
    file.startsWith('src/transport/') ||
    file.startsWith('src/ports/') ||
    file === 'src/progress.ts',
  root: (file) => file.startsWith('src/index.') || file === 'src/public-types.ts',
};

export const resolveBucketFiles = (name: string, universe: readonly string[]): string[] => {
  const predicate = BUCKET_PREDICATES[name];
  if (predicate === undefined) {
    throw new Error(`Unknown bucket "${name}". Known: ${Object.keys(BUCKET_PREDICATES).join(', ')}`);
  }
  return universe.filter(predicate);
};

const resolveSweepFiles = (argv: readonly string[], universe: readonly string[]): string[] => {
  const override = parseFilesOverride(argv);
  if (override !== null) return override;
  const index = argv.indexOf('--bucket');
  const bucket = index === -1 ? undefined : argv[index + 1];
  if (bucket === undefined || bucket.length === 0) return [...universe];
  return resolveBucketFiles(bucket, universe);
};

if (isEntryPoint()) {
  const argv = process.argv.slice(2);
  const result = await runStrykerLocalSweep({
    argv,
    files: resolveSweepFiles(argv, discoverMutateUniverse()),
    spawn: nodeSpawn,
    resetReport: resetReportFile,
    readReport: readReportFile,
    stdout: (line) => process.stdout.write(`${line}\n`),
  });
  process.exit(result.exitCode);
}

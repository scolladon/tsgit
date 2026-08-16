#!/usr/bin/env node
/**
 * RSS/heap memory probe for allocation-heavy read paths.
 *
 *   npm run bench:memory                             # delta-chain + commit-walk-header-cache
 *   TSGIT_BENCH_LARGE=1 npm run bench:memory          # + large-pack spread workload
 *   TSGIT_BENCH_HEADER_CACHE=1 npm run bench:memory   # + above-cap header-cache eviction workload
 *
 * Runs under `node --expose-gc --experimental-strip-types` so it can force a
 * GC before each baseline reading (stable before/after comparisons). Like
 * `profile`, it profiles the compiled `dist/` — a strip-only runtime cannot
 * resolve the source tree's `.js`-extension imports nor parse its
 * parameter-property constructors — so the `bench:memory` script builds first
 * and `openRepository` is imported dynamically from `dist/`. Writes its own
 * artifact (`reports/benchmarks/memory.{json,md}`) alongside — never merged
 * into `bench-summarize.ts`'s timing summary, which only knows wall-clock numbers.
 */
import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { ObjectId } from '../src/domain/objects/index.ts';
import {
  DELTA_CHAIN_FIXTURE,
  ensureScaledFixture,
  type FixtureSpec,
  HEADER_CACHE_FIXTURE,
  LARGE_FIXTURE,
  MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
  SMALL_FAT_BLOB_FIXTURE,
  SMALL_FIXTURE,
} from '../test/bench/support/fixture-generator.ts';

/** The compiled entry — the source tree is unreachable from a strip-only runtime. */
type OpenRepository = typeof import('../src/index.node.ts').openRepository;

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const REPORT_DIR = path.join(ROOT, 'reports', 'benchmarks');
const DIST_ENTRY = path.join(ROOT, 'dist', 'esm', 'index.node.js');

/** Dynamic-import `openRepository` from the built `dist/` (mirrors `profile.ts`). */
const loadOpenRepository = async (): Promise<OpenRepository> => {
  const mod = (await import(pathToFileURL(DIST_ENTRY).href)) as {
    openRepository: OpenRepository;
  };
  return mod.openRepository;
};

// Same deterministic spread as the Part 3 `pack-read-scale` bench: eight
// evenly-spaced indices across the large fixture's 200k blobs, resolved via
// on-disk sharded path. Reproduced (not imported) to keep test/bench and
// tooling decoupled — the generator's own path convention is module-private.
const SHARD_SIZE = 512;
const SPREAD_INDICES = [0, 25_000, 50_000, 75_000, 100_000, 125_000, 150_000, 175_000];
const spreadBlobPath = (blobIndex: number): string =>
  `d${Math.floor(blobIndex / SHARD_SIZE)}/f${blobIndex}.dat`;

interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
}

interface MemoryStat {
  readonly before: number;
  readonly peak: number;
  readonly after: number;
}

interface WorkloadReport {
  readonly workload: string;
  readonly rss: MemoryStat;
  readonly heapUsed: MemoryStat;
  readonly node: string;
  readonly platform: string;
}

// `global.gc` only exists under `--expose-gc`; `@types/node` already
// declares it as `NodeJS.GCFunction | undefined`, so no redeclaration is
// needed here — narrow it once at startup so downstream call sites treat it
// as a plain no-arg function.
const requireGc = (): (() => void) => {
  if (typeof global.gc !== 'function') {
    throw new Error('bench-memory requires --expose-gc for stable baselines');
  }
  return global.gc;
};

const sampleMemory = (): MemorySample => {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed };
};

const maxSample = (a: MemorySample, b: MemorySample): MemorySample => ({
  rss: Math.max(a.rss, b.rss),
  heapUsed: Math.max(a.heapUsed, b.heapUsed),
});

/** GC then sample — the stable "before"/"after" baseline reading. */
const gcBaseline = (gc: () => void): MemorySample => {
  gc();
  return sampleMemory();
};

const toReport = (
  workload: string,
  before: MemorySample,
  peak: MemorySample,
  after: MemorySample,
): WorkloadReport => ({
  workload,
  rss: { before: before.rss, peak: peak.rss, after: after.rss },
  heapUsed: { before: before.heapUsed, peak: peak.heapUsed, after: after.heapUsed },
  node: process.version,
  platform: process.platform,
});

const DELTA_CHAIN_ITERATIONS = 20;

/**
 * Cold read of the deepest-chain object, fresh repo per iteration (empty LRU
 * base-object cache each time) so every iteration replays the full delta
 * chain — the allocation-heavy path this workload targets.
 */
const runDeltaChainWorkload = async (
  gc: () => void,
  openRepository: OpenRepository,
): Promise<WorkloadReport> => {
  const fixture = await ensureScaledFixture(DELTA_CHAIN_FIXTURE);
  const blobId = fixture.firstBlobId as ObjectId;

  const before = gcBaseline(gc);
  let peak = before;
  for (let i = 0; i < DELTA_CHAIN_ITERATIONS; i += 1) {
    const repo = await openRepository({ cwd: fixture.cwd });
    try {
      await repo.primitives.readBlob(blobId);
      peak = maxSample(peak, sampleMemory());
    } finally {
      await repo.dispose();
    }
  }
  const after = gcBaseline(gc);

  return toReport('delta-chain-cold-read', before, peak, after);
};

// Child env with GIT_* stripped — GIT_DIR/GIT_WORK_TREE from a hook would override
// `-C <cwd>` and redirect rev-parse to the wrong repo.
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const resolveSpreadIds = async (cwd: string): Promise<ReadonlyArray<ObjectId>> => {
  const ids: ObjectId[] = [];
  for (const index of SPREAD_INDICES) {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', `HEAD:${spreadBlobPath(index)}`],
      { env: gitEnv() },
    );
    ids.push(stdout.trim() as ObjectId);
  }
  return ids;
};

/**
 * Reads a spread of objects across a cold large pack in one pass — mirrors
 * the Part 3 timing scenario's shape, but measures memory instead of wall
 * clock. Gated behind TSGIT_BENCH_LARGE so the ~500 MB fixture never
 * generates in nightly CI.
 */
const runLargePackWorkload = async (
  gc: () => void,
  openRepository: OpenRepository,
): Promise<WorkloadReport> => {
  const fixture = await ensureScaledFixture(LARGE_FIXTURE);
  const spread = await resolveSpreadIds(fixture.cwd);

  const before = gcBaseline(gc);
  let peak = before;
  const repo = await openRepository({ cwd: fixture.cwd });
  try {
    for (const id of spread) {
      await repo.primitives.readBlob(id);
      peak = maxSample(peak, sampleMemory());
    }
  } finally {
    await repo.dispose();
  }
  const after = gcBaseline(gc);

  return toReport('large-pack-spread-read', before, peak, after);
};

const COMMIT_GRAPH_RELATIVE_PATH = path.join('.git', 'objects', 'info', 'commit-graph');

/**
 * The commit-walk workloads below only exercise `commitHeader` when the
 * fixture carries a commit-graph — assert it up front so an accidentally
 * graph-less fixture fails loudly instead of silently measuring nothing.
 */
const assertCommitGraphPresent = async (cwd: string): Promise<void> => {
  const graphPath = path.join(cwd, COMMIT_GRAPH_RELATIVE_PATH);
  try {
    await access(graphPath);
  } catch {
    throw new Error(`commit-walk-header-cache workload requires a commit-graph at ${graphPath}`);
  }
};

/**
 * Streams the full commit-date-ordered history via `walkCommitsByDate`,
 * retaining nothing per step. Deliberately not `repo.log()`: `log` has no
 * default limit and materialises the whole history into a `LogEntry[]`,
 * whose own retention would swamp the commit-graph header-cache signal this
 * workload exists to read.
 */
const runCommitWalkHeaderCacheWorkload = async (
  gc: () => void,
  openRepository: OpenRepository,
  spec: FixtureSpec,
  workload: string,
): Promise<WorkloadReport> => {
  const fixture = await ensureScaledFixture(spec);
  await assertCommitGraphPresent(fixture.cwd);

  const before = gcBaseline(gc);
  let peak = before;
  const repo = await openRepository({ cwd: fixture.cwd });
  try {
    const walk = repo.primitives.walkCommitsByDate({ from: [fixture.headCommitId as ObjectId] });
    for await (const _commit of walk) {
      peak = maxSample(peak, sampleMemory());
    }
  } finally {
    await repo.dispose();
  }
  const after = gcBaseline(gc);

  return toReport(workload, before, peak, after);
};

/** Commit count stays under the header-cache's 65 536-entry cap — the cap
 *  should not shrink this common case, which the "before vs after" oracle checks. */
const runHeaderCacheWorkload = (
  gc: () => void,
  openRepository: OpenRepository,
): Promise<WorkloadReport> =>
  runCommitWalkHeaderCacheWorkload(
    gc,
    openRepository,
    MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
    'commit-walk-header-cache',
  );

/** Commit count exceeds the header-cache's 65 536-entry cap, so the walk
 *  actually exercises eviction. Gated behind its own env var (independent of
 *  TSGIT_BENCH_LARGE, which also switches on the ~500 MB large-pack fixture). */
const runHeaderCacheLargeWorkload = (
  gc: () => void,
  openRepository: OpenRepository,
): Promise<WorkloadReport> =>
  runCommitWalkHeaderCacheWorkload(
    gc,
    openRepository,
    HEADER_CACHE_FIXTURE,
    'commit-walk-header-cache-large',
  );

/** Concurrent-poller interval for `runFsckObjectCacheWorkload` — short
 *  enough to catch a peak inside a single non-streaming async call, coarse
 *  enough not to dominate the call's own wall clock. */
const PEAK_POLL_INTERVAL_MS = 5;

/**
 * Peak `heapUsed` for `repo.fsck()` over a fixture — fsck's object cache
 * decodes and retains the whole repository universe for the entire command,
 * so this workload is what the structural-projection bound (peak tracks
 * commit/tree count, not blob bytes) is measured against. `SMALL_FIXTURE`
 * and `SMALL_FAT_BLOB_FIXTURE` share the same commit/tree/blob count and
 * differ only in blob content, so the two reports isolate that one variable.
 * `fsck()` is a single non-streaming call with no per-step hook to sample
 * from, so a concurrent poller — not a post-hoc sample — tracks the peak:
 * the command's own I/O awaits give the event loop ticks to run it, and a
 * post-hoc sample alone can read BELOW the true peak once V8's incremental
 * GC reclaims short-lived garbage between those awaits.
 */
const runFsckObjectCacheWorkload = async (
  gc: () => void,
  openRepository: OpenRepository,
  spec: FixtureSpec,
): Promise<WorkloadReport> => {
  const fixture = await ensureScaledFixture(spec);

  const before = gcBaseline(gc);
  let peak = before;
  const poll = setInterval(() => {
    peak = maxSample(peak, sampleMemory());
  }, PEAK_POLL_INTERVAL_MS);
  try {
    const repo = await openRepository({ cwd: fixture.cwd });
    try {
      await repo.fsck();
      peak = maxSample(peak, sampleMemory());
    } finally {
      await repo.dispose();
    }
  } finally {
    clearInterval(poll);
  }
  const after = gcBaseline(gc);

  return toReport(`fsck-object-cache-${spec.label}`, before, peak, after);
};

const toMarkdownRow = (report: WorkloadReport): string =>
  `| ${report.workload} | ${report.rss.before} | ${report.rss.peak} | ${report.rss.after} | ` +
  `${report.heapUsed.before} | ${report.heapUsed.peak} | ${report.heapUsed.after} |`;

const toMarkdown = (reports: ReadonlyArray<WorkloadReport>): string => {
  const header =
    '| workload | rss before | rss peak | rss after | heapUsed before | heapUsed peak | heapUsed after |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |';
  return [header, ...reports.map(toMarkdownRow)].join('\n');
};

const emitReports = async (reports: ReadonlyArray<WorkloadReport>): Promise<void> => {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(
    path.join(REPORT_DIR, 'memory.json'),
    `${JSON.stringify(reports, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(REPORT_DIR, 'memory.md'), `${toMarkdown(reports)}\n`, 'utf8');
};

const main = async (): Promise<void> => {
  const gc = requireGc();
  const openRepository = await loadOpenRepository();

  const reports: WorkloadReport[] = [];
  try {
    reports.push(await runDeltaChainWorkload(gc, openRepository));
    reports.push(await runHeaderCacheWorkload(gc, openRepository));
    reports.push(await runFsckObjectCacheWorkload(gc, openRepository, SMALL_FIXTURE));
    reports.push(await runFsckObjectCacheWorkload(gc, openRepository, SMALL_FAT_BLOB_FIXTURE));
    if (process.env.TSGIT_BENCH_LARGE !== undefined) {
      reports.push(await runLargePackWorkload(gc, openRepository));
    }
    if (process.env.TSGIT_BENCH_HEADER_CACHE !== undefined) {
      reports.push(await runHeaderCacheLargeWorkload(gc, openRepository));
    }
  } catch (err) {
    process.stderr.write(
      `cannot measure memory: fixture unavailable ` +
        `(${err instanceof Error ? err.message : String(err)})\n` +
        'install the `git` CLI and retry.\n',
    );
    process.exit(1);
  }

  await emitReports(reports);
  process.stdout.write(`memory report written to ${REPORT_DIR}\n`);
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

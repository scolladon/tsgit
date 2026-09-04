#!/usr/bin/env node
/**
 * RSS/heap memory probe for allocation-heavy read paths.
 *
 *   npm run bench:memory                             # delta-chain + commit-walk-header-cache
 *                                                     # + fsck object cache + clone quarantine
 *                                                     # (incl. the index-pass base cache's
 *                                                     # own delta-chain fixture) + gc residency
 *   TSGIT_BENCH_LARGE=1 npm run bench:memory          # + large-pack spread workload
 *   TSGIT_BENCH_HEADER_CACHE=1 npm run bench:memory   # + above-cap header-cache eviction workload
 *
 * The clone-quarantine workload clones the same fixture shape at two pack
 * sizes differing >= 4x through a deterministic, in-process `git-http-backend`
 * transport (see `buildDeterministicTransport`), so peak RSS can be compared
 * side by side: streaming the received pack into quarantine (rather than
 * buffering it whole) should keep that peak bounded independently of pack
 * size, unlike the old buffer-then-concat drain.
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
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { ObjectId } from '../src/domain/objects/index.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http-transport.ts';
import {
  DELTA_CHAIN_FIXTURE,
  ensureScaledFixture,
  type FixtureSpec,
  HEADER_CACHE_FIXTURE,
  isFixtureUnavailable,
  LARGE_FIXTURE,
  MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
  SMALL_FAT_BLOB_FIXTURE,
  SMALL_FIXTURE,
} from '../test/bench/support/fixture-generator.ts';
import { findGitHttpBackend } from '../test/bench/support/http-backend-server.ts';

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

// Two pack sizes differing >= 4x — the R17 oracle for clone's quarantine
// streaming: peak RSS should be bounded independently of pack size, not
// scale with it the way the old whole-pack buffer-then-concat drain did.
//
// Both stay well under 64 KiB. A real HTTP client's own internal stream
// buffering (Node's readable highWaterMark defaults to 64 KiB) coalesces
// bytes into delivered chunks the source's own chunking cannot control, and
// a pack whose single sideband pkt-line already approaches that width can
// trip a pre-existing pkt-line-decoder limit unrelated to this change (a
// delivered chunk larger than the decoder's one-pkt-line accumulator is
// rejected even when the pkt-line it completes is well-formed and small).
// Staying under that ceiling keeps this workload deterministic; the decoder
// limit itself is out of scope here.
const CLONE_SMALL_BLOB_BYTES = 12_000;
const CLONE_LARGE_BLOB_BYTES = 60_000;

// Every chunk `buildDeterministicTransport`'s response hands to the client
// is at most this many bytes, regardless of pack size — the explicit control
// a real HTTP stack does not give this workload (see the sizes above).
const TRANSPORT_CHUNK_BYTES = 8192;

interface ClonePackFixture {
  readonly bareDir: string;
  readonly packBytes: number;
}

/** One random, low-entropy-resistant blob committed to a bare repo under
 *  `root/<label>.git` — random content keeps the on-disk pack size tracking
 *  the source content size instead of collapsing under deflate. */
const buildClonePackFixture = async (
  root: string,
  label: string,
  blobBytes: number,
): Promise<ClonePackFixture> => {
  const workDir = path.join(root, `${label}-work`);
  const bareDir = path.join(root, `${label}.git`);
  const env = gitEnv();
  await execFileAsync('git', ['init', '-q', workDir], { env });
  await writeFile(path.join(workDir, 'blob.bin'), randomBytes(blobBytes));
  await execFileAsync('git', ['-C', workDir, 'add', 'blob.bin'], { env });
  await execFileAsync(
    'git',
    [
      '-C',
      workDir,
      '-c',
      'user.email=bench@example.com',
      '-c',
      'user.name=bench',
      'commit',
      '-q',
      '-m',
      'seed',
    ],
    { env },
  );
  await execFileAsync('git', ['clone', '-q', '--bare', workDir, bareDir], { env });
  // A same-filesystem local clone hardlinks the source's LOOSE objects
  // rather than packing them, so `objects/pack/` would otherwise be empty —
  // `repack -a -d` forces exactly one on-disk pack regardless of that
  // clone-local optimization, which `git-http-backend`'s advertised pack
  // transfer needs to have something to serve.
  await execFileAsync('git', ['-C', bareDir, 'repack', '-q', '-a', '-d'], { env });
  const packDir = path.join(bareDir, 'objects', 'pack');
  const packFile = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
  const packBytes = packFile === undefined ? 0 : (await stat(path.join(packDir, packFile))).size;
  return { bareDir, packBytes };
};

// Deep OFS chains over one churned file — the index-pass base cache's own
// working set (base-with-children roots re-read once per pass without it),
// unlike `buildClonePackFixture`'s single random blob above.
const DELTA_CHAIN_CLONE_COMMITS = 60;
const DELTA_CHAIN_CLONE_LINE_COUNT = 400;

/** A bare repo whose single pack carries real OFS delta chains: one text
 *  file rewritten a handful of lines per commit over
 *  `DELTA_CHAIN_CLONE_COMMITS` commits, then `repack -a -d` so the chains
 *  land in one pack exactly as a real clone would receive them. */
const buildDeltaChainClonePackFixture = async (root: string): Promise<ClonePackFixture> => {
  const workDir = path.join(root, 'delta-chain-work');
  const bareDir = path.join(root, 'delta-chain.git');
  const env = gitEnv();
  await execFileAsync('git', ['init', '-q', workDir], { env });
  const filePath = path.join(workDir, 'churn.txt');
  const lines = Array.from(
    { length: DELTA_CHAIN_CLONE_LINE_COUNT },
    (_, i) => `line-${i}-${randomBytes(4).toString('hex')}`,
  );
  const commitOnce = async (message: string): Promise<void> => {
    await writeFile(filePath, `${lines.join('\n')}\n`);
    await execFileAsync('git', ['-C', workDir, 'add', 'churn.txt'], { env });
    await execFileAsync(
      'git',
      [
        '-C',
        workDir,
        '-c',
        'user.email=bench@example.com',
        '-c',
        'user.name=bench',
        'commit',
        '-q',
        '-m',
        message,
      ],
      { env },
    );
  };
  await commitOnce('seed');
  for (let c = 0; c < DELTA_CHAIN_CLONE_COMMITS; c += 1) {
    for (let r = 0; r < 5; r += 1) {
      const idx = (c * 5 + r) % lines.length;
      lines[idx] = `line-${idx}-${randomBytes(4).toString('hex')}`;
    }
    await commitOnce(`c${c}`);
  }
  await execFileAsync('git', ['clone', '-q', '--bare', workDir, bareDir], { env });
  await execFileAsync('git', ['-C', bareDir, '-c', 'pack.threads=1', 'repack', '-q', '-a', '-d'], {
    env,
  });
  const packDir = path.join(bareDir, 'objects', 'pack');
  const packFile = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
  const packBytes = packFile === undefined ? 0 : (await stat(path.join(packDir, packFile))).size;
  return { bareDir, packBytes };
};

// ─── index-pass residency ──────────────────────────────────────────────────
//
// Every other clone reading in this file samples with `setInterval` +
// `process.memoryUsage()`. That oracle CANNOT see this pipeline's peak: pass 2
// awaits only already-settled promises, so the event loop never turns while
// the walk holds its deepest stack. A lazily-released parent frame therefore
// measured identically to an eagerly-released one on every fixture here, and a
// retention defect a remote could trigger shipped past all of them.
//
// Two things are needed to see it, and both are load-bearing:
//   1. a kernel high-water mark (`maxRSS`) read in a FRESH CHILD PROCESS, so
//      the reading is monotonic and cannot be missed between polls;
//   2. a fixture whose objects are large enough that `depth x objectSize` is
//      visible at all. `buildDeltaChainClonePackFixture` above churns ~8 KB
//      revisions, so its ancestor term is ~0.4 MB — invisible either way.
const RESIDENCY_CHILD_FLAG = '--residency-child';
const DEEP_CHAIN_COMMITS = 60;
const DEEP_CHAIN_LINE_COUNT = 60_000;

/** One multi-MiB file churned over `DEEP_CHAIN_COMMITS` commits, repacked into
 *  a single deep OFS chain. Small on the wire, large when reconstructed —
 *  the shape a remote controls and the one the retained-ancestor term is
 *  measured against. */
const buildDeepChainFixture = async (root: string): Promise<ClonePackFixture> => {
  const workDir = path.join(root, 'deep-chain-work');
  const bareDir = path.join(root, 'deep-chain.git');
  const env = gitEnv();
  await execFileAsync('git', ['init', '-q', workDir], { env });
  const filePath = path.join(workDir, 'churn.txt');
  const lines = Array.from(
    { length: DEEP_CHAIN_LINE_COUNT },
    (_, i) => `line-${i}-${randomBytes(8).toString('hex')}`,
  );
  const commitOnce = async (message: string): Promise<void> => {
    await writeFile(filePath, `${lines.join('\n')}\n`);
    await execFileAsync('git', ['-C', workDir, 'add', 'churn.txt'], { env });
    await execFileAsync(
      'git',
      [
        '-C',
        workDir,
        '-c',
        'user.email=bench@example.com',
        '-c',
        'user.name=bench',
        'commit',
        '-q',
        '-m',
        message,
      ],
      { env },
    );
  };
  await commitOnce('seed');
  for (let c = 0; c < DEEP_CHAIN_COMMITS; c += 1) {
    lines[c % lines.length] = `line-${c}-${randomBytes(8).toString('hex')}`;
    await commitOnce(`c${c}`);
  }
  await execFileAsync('git', ['clone', '-q', '--bare', workDir, bareDir], { env });
  // `-f --depth=60 --window=60` forces one long chain rather than the shallow
  // ones git's defaults would pick on this shape.
  await execFileAsync(
    'git',
    [
      '-C',
      bareDir,
      '-c',
      'pack.threads=1',
      'repack',
      '-q',
      '-a',
      '-d',
      '-f',
      '--depth=60',
      '--window=60',
    ],
    { env },
  );
  const packDir = path.join(bareDir, 'objects', 'pack');
  const packFile = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
  const packBytes = packFile === undefined ? 0 : (await stat(path.join(packDir, packFile))).size;
  return { bareDir, packBytes };
};

/** Clone `label` in a fresh child and return that child's own `maxRSS`. */
const measureCloneMaxRssInChild = async (
  backendPath: string,
  root: string,
  label: string,
): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', SCRIPT_PATH, RESIDENCY_CHILD_FLAG, backendPath, root, label],
      { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`residency child for ${label} exited ${String(code)}`));
        return;
      }
      const parsed: unknown = JSON.parse(out.trim());
      if (typeof parsed !== 'object' || parsed === null || !('maxRss' in parsed)) {
        reject(new Error(`residency child for ${label} produced no reading`));
        return;
      }
      resolve(Number((parsed as { maxRss: unknown }).maxRss));
    });
  });

/** The child half: clone once, print this process's own kernel high-water
 *  mark. No sampling, nothing to miss. */
const runResidencyChild = async (
  backendPath: string,
  root: string,
  label: string,
): Promise<void> => {
  const openRepository = await loadOpenRepository();
  const transport = buildDeterministicTransport(backendPath, root);
  const cwd = await mkdtemp(path.join(os.tmpdir(), `tsgit-bench-residency-${label}-`));
  try {
    const repo = await openRepository({
      cwd,
      allowInsecureHttp: true,
      transport,
      config: {
        allowInsecure: true,
        allowPrivateNetworks: true,
        dnsResolver: async () => ['127.0.0.1'],
      },
    });
    try {
      await repo.clone({ url: `http://bench.invalid/${label}.git` });
    } finally {
      await repo.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  // `maxRSS` is reported in kilobytes on darwin and linux alike.
  process.stdout.write(`${JSON.stringify({ maxRss: process.resourceUsage().maxRSS * 1024 })}\n`);
};

/** Peak-RSS cost of indexing a deep chain of large objects, above the cost of
 *  cloning a trivial repository. Both readings come from their own child, so
 *  neither can hide inside the other's high-water mark. */
const runIndexPassResidencyWorkload = async (): Promise<ReadonlyArray<WorkloadReport>> => {
  const backendPath = findGitHttpBackend();
  if (backendPath === undefined) {
    process.stderr.write('skipping index-pass-residency workload: git-http-backend not on $PATH\n');
    return [];
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-residency-src-'));
  try {
    const trivial = await buildClonePackFixture(root, 'residency-trivial', 1024);
    const deep = await buildDeepChainFixture(root);
    const baselineRss = await measureCloneMaxRssInChild(backendPath, root, 'residency-trivial');
    const deepRss = await measureCloneMaxRssInChild(backendPath, root, 'deep-chain');
    return [
      {
        workload:
          `index-pass-residency-deep-chain-pack-${deep.packBytes}B` +
          `-over-trivial-${trivial.packBytes}B`,
        // A child's high-water mark only ever rises, so `after` is `peak`.
        rss: { before: baselineRss, peak: deepRss, after: deepRss },
        heapUsed: { before: 0, peak: 0, after: 0 },
        node: process.version,
        platform: process.platform,
      },
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const findHeaderSeparator = (buf: Buffer): number => {
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i;
    if (
      i < buf.length - 3 &&
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
};

interface CgiResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

interface CgiStatusAndHeaders {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
}

/** Parses `Status:`/other CGI response headers into `{ statusCode, headers }`
 *  — split out of `runGitHttpBackendCgi`'s `close` handler purely to keep
 *  that handler's own cognitive complexity low. */
const parseCgiHeaders = (headerBuf: Buffer): CgiStatusAndHeaders => {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  for (const line of headerBuf.toString('utf8').split(/\r?\n/)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === 'status') {
      const parsed = Number.parseInt(value.split(' ', 1)[0] ?? '200', 10);
      if (Number.isFinite(parsed)) statusCode = parsed;
      continue;
    }
    headers[key.toLowerCase()] = value;
  }
  return { statusCode, headers };
};

/** Splits a raw CGI response into its header block and body, or `undefined`
 *  when no header/body separator is found. */
const splitCgiResponse = (raw: Buffer): { headerBuf: Buffer; body: Buffer } | undefined => {
  const sep = findHeaderSeparator(raw);
  if (sep < 0) return undefined;
  return {
    headerBuf: raw.subarray(0, sep),
    body: raw.subarray(sep + (raw[sep] === 0x0d ? 4 : 2)),
  };
};

/** Runs one `git-http-backend` CGI request directly (no listening HTTP
 *  server, no socket) — the caller frames the raw output as an
 *  `HttpResponse` with its own explicit, bounded chunking. */
const runGitHttpBackendCgi = async (
  backendPath: string,
  projectRoot: string,
  req: HttpRequest,
): Promise<CgiResult> => {
  const url = new URL(req.url);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    REQUEST_METHOD: req.method,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: String(req.body?.byteLength ?? 0),
    REMOTE_ADDR: '127.0.0.1',
  };
  return new Promise<CgiResult>((resolve, reject) => {
    const child = spawn(backendPath, [], { env });
    child.stdin.on('error', () => undefined);
    child.stdin.end(req.body === undefined ? undefined : Buffer.from(req.body));
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', () => {
      const split = splitCgiResponse(Buffer.concat(chunks));
      if (split === undefined) {
        reject(new Error('git-http-backend CGI response missing header separator'));
        return;
      }
      resolve({ ...parseCgiHeaders(split.headerBuf), body: split.body });
    });
  });
};

/** Frames `buffer` as a `ReadableStream` whose enqueues are always
 *  `TRANSPORT_CHUNK_BYTES` or smaller — see the pack-size constants' comment
 *  for why this workload does not rely on a real HTTP stack's own chunking. */
const chunkedBodyStream = (buffer: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < buffer.length; offset += TRANSPORT_CHUNK_BYTES) {
        controller.enqueue(buffer.subarray(offset, offset + TRANSPORT_CHUNK_BYTES));
      }
      controller.close();
    },
  });

/** A deterministic, in-process `HttpTransport`: spawns `git-http-backend`
 *  directly per request instead of going through a listening `http.Server`
 *  and a real socket — no network stack between server and client left to
 *  rebuffer the response in ways this workload cannot control. */
const buildDeterministicTransport = (backendPath: string, projectRoot: string): HttpTransport => ({
  request: async (req: HttpRequest): Promise<HttpResponse> => {
    const result = await runGitHttpBackendCgi(backendPath, projectRoot, req);
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      body: chunkedBodyStream(result.body),
    };
  },
});

/** Peak RSS for one `openRepository → repo.clone → repo.dispose` cycle
 *  against the deterministic transport, labelled with the source pack size
 *  so the two readings can be compared directly in the report. */
const runOneCloneMeasurement = async (
  gc: () => void,
  openRepository: OpenRepository,
  transport: HttpTransport,
  label: string,
  packBytes: number,
): Promise<WorkloadReport> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `tsgit-bench-clone-dst-${label}-`));
  const url = `http://bench.invalid/${label}.git`;
  const before = gcBaseline(gc);
  let peak = before;
  const poll = setInterval(() => {
    peak = maxSample(peak, sampleMemory());
  }, PEAK_POLL_INTERVAL_MS);
  try {
    const repo = await openRepository({
      cwd,
      allowInsecureHttp: true,
      transport,
      config: {
        allowInsecure: true,
        allowPrivateNetworks: true,
        dnsResolver: async () => ['127.0.0.1'],
      },
    });
    try {
      await repo.clone({ url });
      peak = maxSample(peak, sampleMemory());
    } finally {
      await repo.dispose();
    }
  } finally {
    clearInterval(poll);
    await rm(cwd, { recursive: true, force: true });
  }
  const after = gcBaseline(gc);
  return toReport(`clone-quarantine-${label}-pack-${packBytes}B`, before, peak, after);
};

/**
 * Clones the same two fixtures at pack sizes differing >= 4x through a
 * deterministic in-process transport, reporting peak RSS for each. Skips
 * gracefully (no report entries, no failure) when `git-http-backend` is not
 * on `$PATH` — this script must not take the whole memory report down over
 * an environment that lacks it.
 */
const runCloneWorkload = async (
  gc: () => void,
  openRepository: OpenRepository,
): Promise<ReadonlyArray<WorkloadReport>> => {
  const backendPath = findGitHttpBackend();
  if (backendPath === undefined) {
    process.stderr.write('skipping clone-quarantine workload: git-http-backend not on $PATH\n');
    return [];
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-clone-src-'));
  try {
    const small = await buildClonePackFixture(root, 'small', CLONE_SMALL_BLOB_BYTES);
    const large = await buildClonePackFixture(root, 'large', CLONE_LARGE_BLOB_BYTES);
    const deltaChain = await buildDeltaChainClonePackFixture(root);
    const transport = buildDeterministicTransport(backendPath, root);
    return [
      await runOneCloneMeasurement(gc, openRepository, transport, 'small', small.packBytes),
      await runOneCloneMeasurement(gc, openRepository, transport, 'large', large.packBytes),
      // Exercises the index-pass base cache at its shipped default budget
      // through the real receive path — the ongoing regression signal for
      // R1/R2's residency claim; the sizing sweep that picked the default
      // itself is a one-off local measurement recorded in the base-cache
      // budget spike doc, not something this nightly workload re-derives.
      await runOneCloneMeasurement(
        gc,
        openRepository,
        transport,
        'delta-chain',
        deltaChain.packBytes,
      ),
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// `maintenance`'s `gc` repacks the whole repository and is the highest
// object-count write path this library has — the argument for turning this
// cache on in the first place, so leaving it unmeasured would be the one
// place the change's headline reduction went unproven. Kept modest (loose
// object count, not a scaled fixture) so it stays inside the same nightly
// budget the rest of this script already runs in.
const GC_RESIDENCY_LOOSE_OBJECT_COUNT = 3_000;
const GC_RESIDENCY_AUTHOR = {
  name: 'bench',
  email: 'bench@tsgit.invalid',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/**
 * Peak RSS for `maintenance({tasks:['gc']})` over freshly seeded reachable
 * loose objects — this branch's absolute number. `fileCount` committed
 * working-tree files, one flat commit (gc's cost is driven by object
 * count, not commit-graph depth), mirroring `test/bench/support/
 * write-scratch.ts`'s `buildManyLooseObjectsScratch` shape — reproduced
 * rather than imported, since that helper's own `.js`-suffixed imports
 * pull in the source tree, which this strip-types script cannot resolve
 * (see the module doc comment; `openRepository` itself is dynamic-imported
 * from `dist/` for exactly this reason).
 *
 * Comparing this branch's peak against `main`'s absolute peak on the
 * identical fixture (never a ratio or a self-share delta, both of which
 * are Amdahl-fragile against `buildPack`'s own untouched deltify/
 * window-search cost) is a manual step recorded in the base-cache budget
 * spike doc, not something this script automates — doing so would need a
 * second checked-out build of the library, out of scope for a script whose
 * job is measuring ONE tree.
 */
const runGcResidencyWorkload = async (
  gc: () => void,
  openRepository: OpenRepository,
): Promise<WorkloadReport> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-gc-residency-'));
  const before = gcBaseline(gc);
  let peak = before;
  const poll = setInterval(() => {
    peak = maxSample(peak, sampleMemory());
  }, PEAK_POLL_INTERVAL_MS);
  try {
    const repo = await openRepository({ cwd });
    try {
      await repo.init();
      for (let i = 0; i < GC_RESIDENCY_LOOSE_OBJECT_COUNT; i += 1) {
        await writeFile(path.join(cwd, `f${i.toString().padStart(6, '0')}.txt`), `payload ${i}\n`);
      }
      await repo.add([], { all: true });
      await repo.commit({
        message: 'seed',
        author: GC_RESIDENCY_AUTHOR,
        committer: GC_RESIDENCY_AUTHOR,
      });
      await repo.maintenance({ tasks: ['gc'] });
      peak = maxSample(peak, sampleMemory());
    } finally {
      await repo.dispose();
    }
  } finally {
    clearInterval(poll);
    await rm(cwd, { recursive: true, force: true });
  }
  const after = gcBaseline(gc);
  return toReport(
    `gc-residency-${GC_RESIDENCY_LOOSE_OBJECT_COUNT}-loose-objects`,
    before,
    peak,
    after,
  );
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
  const childArgs = process.argv.slice(2);
  if (childArgs[0] === RESIDENCY_CHILD_FLAG) {
    const [, backendPath, root, label] = childArgs;
    if (backendPath === undefined || root === undefined || label === undefined) {
      throw new Error(`${RESIDENCY_CHILD_FLAG} needs <backendPath> <root> <label>`);
    }
    await runResidencyChild(backendPath, root, label);
    return;
  }
  const gc = requireGc();
  const openRepository = await loadOpenRepository();

  const reports: WorkloadReport[] = [];
  try {
    reports.push(await runDeltaChainWorkload(gc, openRepository));
    reports.push(await runHeaderCacheWorkload(gc, openRepository));
    reports.push(await runFsckObjectCacheWorkload(gc, openRepository, SMALL_FIXTURE));
    reports.push(await runFsckObjectCacheWorkload(gc, openRepository, SMALL_FAT_BLOB_FIXTURE));
    reports.push(...(await runCloneWorkload(gc, openRepository)));
    reports.push(...(await runIndexPassResidencyWorkload()));
    reports.push(await runGcResidencyWorkload(gc, openRepository));
    if (process.env.TSGIT_BENCH_LARGE !== undefined) {
      reports.push(await runLargePackWorkload(gc, openRepository));
    }
    // Opt-in only: nightly bench.yml runs a bare `npm run bench:memory`, so
    // the above-cap eviction reading is a LOCAL-ONLY measurement by design —
    // the 70k-commit fixture is too expensive to regenerate inside the
    // nightly job's 30-minute budget. Its recorded readings live in the
    // header-cache decision record. Note the fixture sits only ~1.07x above
    // the 65 536 cap, so it measures overhead-at-the-cap, not the bound's
    // payoff at scale.
    if (process.env.TSGIT_BENCH_HEADER_CACHE !== undefined) {
      reports.push(await runHeaderCacheLargeWorkload(gc, openRepository));
    }
  } catch (err) {
    if (!isFixtureUnavailable(err)) throw err;
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

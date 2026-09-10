#!/usr/bin/env node
/**
 * Pack-size comparison driver — the design's §11 measurement contract as one
 * committed procedure instead of five hand-typed variants a reviewer cannot
 * re-run. Runs tsgit's `gc` (via the built `dist/`, mirroring `bench-memory.ts`)
 * against real git's selection peer — `repack -a -d -f`, never `gc`, which
 * reuses inherited deltas instead of re-selecting — over three corpora, and
 * prints one structural report per corpus: byte sizes, the size ratio (gated
 * on equal object counts on both sides), and a `verify-pack -v` readout with
 * blob and tree lines partitioned separately.
 *
 * Both scaled corpora (`DELTA_CHAIN_FIXTURE`, `MEDIUM_FIXTURE`) are the
 * shared, cached fixture — never mutated in place; each tool gets its own
 * `cp -r` scratch copy. The third corpus is tsgit's own history as a fresh
 * `git clone --no-local`, so neither side starts with an unreachable object.
 *
 *   npm run build && node --experimental-strip-types tooling/pack-size-compare.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MaintenanceResult } from '../src/application/commands/maintenance.ts';
import {
  DELTA_CHAIN_FIXTURE,
  ensureScaledFixture,
  type FixtureSpec,
  MEDIUM_FIXTURE,
} from '../test/bench/support/fixture-generator.ts';
import { copyFixtureToScratch } from '../test/bench/support/fixture-scratch.ts';

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, exported so the unit test can reach them directly.
// ---------------------------------------------------------------------------

export interface TypeReadout {
  readonly baseCount: number;
  readonly deltaCount: number;
  readonly histogram: ReadonlyMap<number, number>;
  readonly maxDepth: number;
}

export interface VerifyPackReadout {
  readonly blob: TypeReadout;
  readonly tree: TypeReadout;
}

type TrackedObjectType = 'blob' | 'tree';

// `git verify-pack -v` object line: `<sha> <type> <size> <size-in-pack>
// <offset> [<depth> <base-sha>]` — a base line has 5 fields, a delta line 7;
// the depth column sits at index 5, so 6 fields is the minimum to read it
// (mirrors `fixture-generator.ts`'s `maxChainDepthOid`).
const BASE_LINE_MIN_FIELDS = 5;
const DELTA_LINE_MIN_FIELDS = 6;
const DEPTH_FIELD_INDEX = 5;

const isTrackedObjectType = (value: string | undefined): value is TrackedObjectType =>
  value === 'blob' || value === 'tree';

interface TypeAccumulator {
  baseCount: number;
  deltaCount: number;
  readonly histogram: Map<number, number>;
}

const newAccumulator = (): TypeAccumulator => ({
  baseCount: 0,
  deltaCount: 0,
  histogram: new Map(),
});

const recordLine = (accumulator: TypeAccumulator, tokens: readonly string[]): void => {
  if (tokens.length >= DELTA_LINE_MIN_FIELDS) {
    accumulator.deltaCount += 1;
    const depth = Number(tokens[DEPTH_FIELD_INDEX]);
    accumulator.histogram.set(depth, (accumulator.histogram.get(depth) ?? 0) + 1);
    return;
  }
  if (tokens.length >= BASE_LINE_MIN_FIELDS) accumulator.baseCount += 1;
};

const toTypeReadout = (accumulator: TypeAccumulator): TypeReadout => ({
  baseCount: accumulator.baseCount,
  deltaCount: accumulator.deltaCount,
  histogram: accumulator.histogram,
  maxDepth: accumulator.histogram.size === 0 ? 0 : Math.max(...accumulator.histogram.keys()),
});

/**
 * Parses `git verify-pack -v` output into blob and tree readouts, kept
 * separate rather than merged — a chain that saturates on blobs and stays
 * flat on trees (or vice versa) is exactly what a shifted ratio must show.
 * Commit, tag, non-object and trailer lines (the `chain length = N:`
 * histogram, the final `<path>: ok`) are skipped: they carry neither
 * `blob` nor `tree` at the type column.
 */
export const parseVerifyPackReadout = (verifyPackOutput: string): VerifyPackReadout => {
  const accumulators: Record<TrackedObjectType, TypeAccumulator> = {
    blob: newAccumulator(),
    tree: newAccumulator(),
  };
  for (const line of verifyPackOutput.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    const type = tokens[1];
    if (!isTrackedObjectType(type)) continue;
    recordLine(accumulators[type], tokens);
  }
  return { blob: toTypeReadout(accumulators.blob), tree: toTypeReadout(accumulators.tree) };
};

export interface ComparableSizes {
  readonly oursBytes: number;
  readonly peerBytes: number;
  readonly oursObjectCount: number;
  readonly peerObjectCount: number;
}

/**
 * The comparability gate (design §11a): object counts must be equal on both
 * sides before any byte is divided. A mismatch is a measurement defect, not
 * a result, so it throws — naming both counts — rather than returning a
 * ratio over packs that do not hold the same objects.
 */
export const computeSizeRatio = (sizes: ComparableSizes): number => {
  const { oursObjectCount, peerObjectCount, oursBytes, peerBytes } = sizes;
  if (oursObjectCount !== peerObjectCount) {
    throw new Error(
      `pack-size-compare: object count mismatch — ours has ${oursObjectCount}, peer has ${peerObjectCount}; not comparable`,
    );
  }
  return oursBytes / peerBytes;
};

export const formatRatio = (ratio: number): string => `×${ratio.toFixed(2)}`;

export const renderHistogram = (histogram: ReadonlyMap<number, number>): string =>
  [...histogram.entries()]
    .sort(([depthA], [depthB]) => depthA - depthB)
    .map(([depth, count]) => `${depth}:${count}`)
    .join(', ');

export const renderTypeReadout = (readout: TypeReadout): string =>
  `base=${readout.baseCount} delta=${readout.deltaCount} maxDepth=${readout.maxDepth} histogram={${renderHistogram(readout.histogram)}}`;

export interface PackMeasurement {
  readonly bytes: number;
  readonly objectCount: number;
  readonly readout: VerifyPackReadout;
}

export interface CorpusRow {
  readonly corpus: string;
  readonly gitVersion: string;
  readonly ours: PackMeasurement;
  readonly peer: PackMeasurement;
}

/**
 * One printable report per corpus: byte sizes, the gated ratio, and the
 * structural readout beside it — the pieces that show *why* a ratio moved.
 */
export const renderCorpusReport = (row: CorpusRow): string => {
  const ratio = computeSizeRatio({
    oursBytes: row.ours.bytes,
    peerBytes: row.peer.bytes,
    oursObjectCount: row.ours.objectCount,
    peerObjectCount: row.peer.objectCount,
  });
  return [
    `=== ${row.corpus} (${row.gitVersion}) ===`,
    `ours: ${row.ours.bytes} bytes, ${row.ours.objectCount} objects`,
    `peer: ${row.peer.bytes} bytes, ${row.peer.objectCount} objects`,
    `ratio (ours/peer): ${formatRatio(ratio)}`,
    `ours blob: ${renderTypeReadout(row.ours.readout.blob)}`,
    `ours tree: ${renderTypeReadout(row.ours.readout.tree)}`,
    `peer blob: ${renderTypeReadout(row.peer.readout.blob)}`,
    `peer tree: ${renderTypeReadout(row.peer.readout.tree)}`,
  ].join('\n');
};

// ---------------------------------------------------------------------------
// I/O shell — thin by design: every decision worth a unit test lives above.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'esm', 'index.node.js');

/** The compiled entry — the source tree is unreachable from a strip-only runtime (mirrors `bench-memory.ts`). */
type OpenRepository = typeof import('../src/index.node.ts').openRepository;

const loadOpenRepository = async (): Promise<OpenRepository> => {
  const mod = (await import(pathToFileURL(DIST_ENTRY).href)) as { openRepository: OpenRepository };
  return mod.openRepository;
};

// Isolated, deliberately non-existent HOME plus GIT_CONFIG_NOSYSTEM: a
// spawned git must never read the developer's global/system config, and
// every GIT_* var is stripped so an inherited GIT_DIR cannot redirect a
// `-C <scratch>` invocation to the wrong repository (`.claude/workflow/
// faithfulness.md`).
const ISOLATED_HOME = path.join(os.tmpdir(), 'tsgit-pack-size-compare-nonexistent-home');

const scrubbedGitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  HOME: ISOLATED_HOME,
  XDG_CONFIG_HOME: path.join(ISOLATED_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
});

// `verify-pack -v` and `show-index` print one line per object — MEDIUM_FIXTURE
// alone carries tens of thousands of them, well past `execFileSync`'s default
// 1 MB `maxBuffer` (which fails as a raw `ENOBUFS`, not a readable error).
const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;

const runGit = (args: readonly string[], input?: Uint8Array): string =>
  execFileSync('git', args, {
    env: scrubbedGitEnv(),
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    ...(input === undefined ? {} : { input }),
  }).toString();

const gitVersionString = (): string => runGit(['--version']).trim();

const gitPackDir = (cwd: string): string => {
  const relative = runGit(['-C', cwd, 'rev-parse', '--git-path', 'objects/pack']).trim();
  return path.resolve(cwd, relative);
};

const solePackFiles = async (
  packDir: string,
): Promise<{ readonly pack: string; readonly idx: string }> => {
  const entries = await readdir(packDir);
  const packName = entries.find((entry) => entry.endsWith('.pack'));
  const idxName = entries.find((entry) => entry.endsWith('.idx'));
  if (packName === undefined || idxName === undefined) {
    throw new Error(`pack-size-compare: no single .pack/.idx pair under ${packDir}`);
  }
  return { pack: path.join(packDir, packName), idx: path.join(packDir, idxName) };
};

const countIndexObjects = async (idxPath: string): Promise<number> => {
  const idxBytes = await readFile(idxPath);
  const out = runGit(['show-index'], idxBytes);
  return out.split('\n').filter((line) => line.trim().length > 0).length;
};

const verifyPackReadoutOf = (idxPath: string): VerifyPackReadout =>
  parseVerifyPackReadout(runGit(['verify-pack', '-v', idxPath]));

const measurePack = async (packPath: string, idxPath: string): Promise<PackMeasurement> => {
  const { size } = await stat(packPath);
  const objectCount = await countIndexObjects(idxPath);
  return { bytes: size, objectCount, readout: verifyPackReadoutOf(idxPath) };
};

// Fresh single-threaded selection at the defaults both packers share — the
// design's peer command. `gc` is not a selection peer: it reuses inherited
// deltas rather than re-selecting.
const PEER_REPACK_ARGS = [
  '-c',
  'pack.threads=1',
  '-c',
  'pack.window=10',
  '-c',
  'pack.depth=50',
  'repack',
  '-a',
  '-d',
  '-f',
  '-q',
] as const;

const runPeerRepack = async (scratchDir: string): Promise<PackMeasurement> => {
  runGit(['-C', scratchDir, ...PEER_REPACK_ARGS]);
  const { pack, idx } = await solePackFiles(gitPackDir(scratchDir));
  return measurePack(pack, idx);
};

const assertNoCruftPack = (result: MaintenanceResult): void => {
  if (result.cruftPackId !== undefined) {
    throw new Error(
      `pack-size-compare: unexpected cruft pack ${result.cruftPackId} — corpus is not clean`,
    );
  }
};

const requirePackId = (result: MaintenanceResult): string => {
  if (result.packId === undefined) {
    throw new Error('pack-size-compare: gc packed no reachable objects');
  }
  return result.packId;
};

const runOursGc = async (
  scratchDir: string,
  openRepository: OpenRepository,
): Promise<PackMeasurement> => {
  const repo = await openRepository({ cwd: scratchDir });
  let result: MaintenanceResult;
  try {
    result = await repo.maintenance({ tasks: ['gc'] });
  } finally {
    await repo.dispose();
  }
  assertNoCruftPack(result);
  const packId = requirePackId(result);
  const packDir = gitPackDir(scratchDir);
  return measurePack(
    path.join(packDir, `pack-${packId}.pack`),
    path.join(packDir, `pack-${packId}.idx`),
  );
};

interface CorpusSource {
  readonly label: string;
  readonly cwd: string;
  readonly cleanup?: () => Promise<void>;
}

const scaledCorpusSource = async (label: string, spec: FixtureSpec): Promise<CorpusSource> => {
  const fixture = await ensureScaledFixture(spec);
  return { label, cwd: fixture.cwd };
};

const HISTORY_CORPUS_LABEL = "tsgit's own history (fresh clone)";

/**
 * A fresh `git clone --no-local` of this checkout: cloning only ever
 * transfers reachable objects, so — unlike the working repository, which
 * carries thousands of unreachable objects — neither side of the comparison
 * starts with any.
 */
const historyCorpusSource = async (): Promise<CorpusSource> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pack-size-compare-history-'));
  runGit(['clone', '--no-local', '--quiet', ROOT, dir]);
  return {
    label: HISTORY_CORPUS_LABEL,
    cwd: dir,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
};

/**
 * The design's stated precondition is a corpus with no unreachable object on
 * either side. A long-lived cached fixture is not guaranteed to hold that —
 * `MEDIUM_FIXTURE`'s cache measured with dangling objects, litter from its
 * own generator's cache-identity probing, not from either packer under
 * test — so each scratch copy is pruned before the measured operation runs,
 * making the precondition an enforced invariant rather than an assumption.
 * Real git's `gc --prune=now` is unconditional (never gated by `gc.auto`);
 * this never touches the shared, read-only cache, only the disposable copy.
 */
const pruneUnreachable = (scratchDir: string): void => {
  runGit(['-C', scratchDir, 'gc', '--prune=now', '--quiet']);
};

const measureCorpus = async (
  source: CorpusSource,
  openRepository: OpenRepository,
  gitVersion: string,
): Promise<CorpusRow> => {
  const peerScratch = await copyFixtureToScratch(source.cwd);
  const oursScratch = await copyFixtureToScratch(source.cwd);
  try {
    pruneUnreachable(peerScratch.cwd);
    pruneUnreachable(oursScratch.cwd);
    const peer = await runPeerRepack(peerScratch.cwd);
    const ours = await runOursGc(oursScratch.cwd, openRepository);
    return { corpus: source.label, gitVersion, peer, ours };
  } finally {
    await peerScratch.dispose();
    await oursScratch.dispose();
    await source.cleanup?.();
  }
};

const SCALED_CORPORA: ReadonlyArray<{ readonly label: string; readonly spec: FixtureSpec }> = [
  { label: 'DELTA_CHAIN', spec: DELTA_CHAIN_FIXTURE },
  { label: 'MEDIUM', spec: MEDIUM_FIXTURE },
];

const collectCorpusSources = async (): Promise<readonly CorpusSource[]> => {
  const sources: CorpusSource[] = [];
  for (const corpus of SCALED_CORPORA) {
    sources.push(await scaledCorpusSource(corpus.label, corpus.spec));
  }
  sources.push(await historyCorpusSource());
  return sources;
};

const main = async (): Promise<void> => {
  const gitVersion = gitVersionString();
  const openRepository = await loadOpenRepository();
  const sources = await collectCorpusSources();

  for (const source of sources) {
    const row = await measureCorpus(source, openRepository, gitVersion);
    process.stdout.write(`${renderCorpusReport(row)}\n\n`);
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

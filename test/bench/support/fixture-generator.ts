/**
 * Deterministic scaled-fixture generator.
 *
 * Builds a medium (5k commits / 20k blobs / ~50 MB) or large (50k / 200k /
 * ~500 MB) git repository via `git fast-import` and caches it under
 * `~/.cache/tsgit-bench`. Generation runs once; later calls are cache hits.
 * fast-import is used for speed, a version-keyed cache for reuse, seeded-PRNG
 * blob content so the pack is representative, and a non-bare repo so `status`
 * benchmarks have a real working tree to scan.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Bumped whenever the fixture shape changes — invalidates stale caches.
 * `bench.yml` keys its `actions/cache` on a hash of this file, so a version
 * bump there propagates the same way.
 */
const FIXTURE_GENERATOR_VERSION = 3;

const BLOBS_PER_COMMIT = 4;
const SHARD_SIZE = 512;
const AUTHOR = 'tsgit bench <bench@tsgit.invalid>';
const BASE_TIMESTAMP = 1_700_000_000;

export interface FixtureSpec {
  readonly label:
    | 'small'
    | 'medium'
    | 'medium-commit-graph'
    | 'large'
    | 'delta-chain'
    | 'deep-ancestry-small'
    | 'deep-ancestry-medium'
    | 'deep-ancestry-large'
    | 'header-cache'
    | 'many-pack'
    | 'many-pack-no-midx'
    | 'single-pack'
    | 'loose-only';
  readonly strategy: 'multi' | 'evolving' | 'deep-ancestry' | 'many-pack';
  readonly commits: number;
  /** Led by strategy; for 'evolving'/'deep-ancestry'/'many-pack' this is NOT a file count. */
  readonly blobs: number;
  readonly blobBytes: number;
  /** `git repack --depth`, evolving strategy only. */
  readonly deltaDepth?: number;
  /** `git repack --window`, evolving strategy only. */
  readonly deltaWindow?: number;
  /** Run `git commit-graph write --reachable` once the repo is built. */
  readonly commitGraph?: boolean;
  /** Number of packs to build, `many-pack` strategy only (0 = loose-only). */
  readonly packs?: number;
  /** Run `git multi-pack-index write` once the packs are built, `many-pack` strategy only. */
  readonly midx?: boolean;
}

export const SMALL_FIXTURE: FixtureSpec = {
  label: 'small',
  strategy: 'multi',
  commits: 50,
  blobs: 200,
  blobBytes: 2_560,
};

export const MEDIUM_FIXTURE: FixtureSpec = {
  label: 'medium',
  strategy: 'multi',
  commits: 5_000,
  blobs: 20_000,
  blobBytes: 2_560,
};

/** `MEDIUM_FIXTURE` plus a written single-file commit-graph — exercises the commit-graph read path against the plain object-read walk. */
export const MEDIUM_FIXTURE_WITH_COMMIT_GRAPH: FixtureSpec = {
  ...MEDIUM_FIXTURE,
  label: 'medium-commit-graph',
  commitGraph: true,
};

export const LARGE_FIXTURE: FixtureSpec = {
  label: 'large',
  strategy: 'multi',
  commits: 50_000,
  blobs: 200_000,
  blobBytes: 2_560,
};

// P chosen large enough that a per-pack `.idx` scan is the dominant lookup
// term (§D7) while staying cheap to build+cache: each pack costs one
// fast-import + one repack subprocess pair.
const MANY_PACK_COUNT = 48;
const MANY_PACK_BLOB_BYTES = 512;

export const MANY_PACK_FIXTURE: FixtureSpec = {
  label: 'many-pack',
  strategy: 'many-pack',
  commits: MANY_PACK_COUNT,
  blobs: MANY_PACK_COUNT,
  blobBytes: MANY_PACK_BLOB_BYTES,
  packs: MANY_PACK_COUNT,
  midx: true,
};

/** `MANY_PACK_FIXTURE`'s own shape without a multi-pack-index — isolates the midx's contribution to the same many-pack lookup (§D7's with/without pair). */
export const MANY_PACK_FIXTURE_NO_MIDX: FixtureSpec = {
  ...MANY_PACK_FIXTURE,
  label: 'many-pack-no-midx',
  midx: false,
};

/** P = 1, no midx — the regression-guard floor: the midx machinery must not slow the trivial single-pack case. */
export const SINGLE_PACK_FIXTURE: FixtureSpec = {
  label: 'single-pack',
  strategy: 'many-pack',
  commits: 1,
  blobs: 1,
  blobBytes: MANY_PACK_BLOB_BYTES,
  packs: 1,
  midx: false,
};

/** No packs at all — prices the §D4.5 `assertLoadable` gate in isolation, ahead of every `tryLoose` read. */
export const LOOSE_ONLY_FIXTURE: FixtureSpec = {
  label: 'loose-only',
  strategy: 'many-pack',
  commits: 1,
  blobs: 1,
  blobBytes: MANY_PACK_BLOB_BYTES,
  packs: 0,
  midx: false,
};

const DELTA_CHAIN_COMMITS = 300;
const DELTA_CHAIN_BLOB_BYTES = 4_096;
// --depth caps chain length at DELTA_CHAIN_DEPTH; a wider --window than
// git's default (10) is needed to walk deep enough to approach that cap.
const DELTA_CHAIN_DEPTH = 50;
const DELTA_CHAIN_WINDOW = 250;

export const DELTA_CHAIN_FIXTURE: FixtureSpec = {
  label: 'delta-chain',
  strategy: 'evolving',
  commits: DELTA_CHAIN_COMMITS,
  blobs: 1,
  blobBytes: DELTA_CHAIN_BLOB_BYTES,
  deltaDepth: DELTA_CHAIN_DEPTH,
  deltaWindow: DELTA_CHAIN_WINDOW,
};

// Deep-ancestry commit counts are shape-calibrated, NOT the multi tiers'
// 50/5 000/50 000 — blame walks the full ancestry (O(commit count)), so a
// medium/large sized to the multi tiers would blow the bench testTimeout.
const DEEP_ANCESTRY_SMALL_COMMITS = 50;
const DEEP_ANCESTRY_MEDIUM_COMMITS = 500;
const DEEP_ANCESTRY_LARGE_COMMITS = 2_000;
const DEEP_ANCESTRY_BLOB_BYTES = 256;

export const DEEP_ANCESTRY_SMALL: FixtureSpec = {
  label: 'deep-ancestry-small',
  strategy: 'deep-ancestry',
  commits: DEEP_ANCESTRY_SMALL_COMMITS,
  blobs: 1,
  blobBytes: DEEP_ANCESTRY_BLOB_BYTES,
};

export const DEEP_ANCESTRY_MEDIUM: FixtureSpec = {
  label: 'deep-ancestry-medium',
  strategy: 'deep-ancestry',
  commits: DEEP_ANCESTRY_MEDIUM_COMMITS,
  blobs: 1,
  blobBytes: DEEP_ANCESTRY_BLOB_BYTES,
};

export const DEEP_ANCESTRY_LARGE: FixtureSpec = {
  label: 'deep-ancestry-large',
  strategy: 'deep-ancestry',
  commits: DEEP_ANCESTRY_LARGE_COMMITS,
  blobs: 1,
  blobBytes: DEEP_ANCESTRY_BLOB_BYTES,
};

// Sized above the commit-graph header cache's 65 536-entry cap so a full
// walk actually exercises eviction — no existing spec crosses that line
// (LARGE_FIXTURE tops out at 50 000 commits).
const HEADER_CACHE_COMMITS = 70_000;
const HEADER_CACHE_BLOB_BYTES = 256;

export const HEADER_CACHE_FIXTURE: FixtureSpec = {
  label: 'header-cache',
  strategy: 'deep-ancestry',
  commits: HEADER_CACHE_COMMITS,
  blobs: 1,
  blobBytes: HEADER_CACHE_BLOB_BYTES,
  commitGraph: true,
};

export interface ScaledFixture {
  /** Cached repo path. Never delete it — it is the cache. */
  readonly cwd: string;
  readonly headCommitId: string;
  readonly firstBlobId: string;
  /** The blob committed into the LAST pack built — `many-pack` strategy only. */
  readonly lastBlobId?: string;
  readonly spec: FixtureSpec;
}

interface FixtureMeta {
  readonly version: number;
  readonly headCommitId: string;
  readonly firstBlobId: string;
  readonly lastBlobId?: string;
  readonly spec: FixtureSpec;
}

/** Thrown when the `git` CLI is absent; callers catch generically and skip. */
class FixtureUnavailableError extends Error {
  constructor(reason: string) {
    super(`scaled bench fixture unavailable: ${reason}`);
    this.name = 'FixtureUnavailableError';
  }
}

const cacheRoot = (): string => {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'tsgit-bench');
};

const cacheDirFor = (spec: FixtureSpec): string =>
  path.join(cacheRoot(), `${spec.label}-v${FIXTURE_GENERATOR_VERSION}`);

const blobPath = (blobIndex: number): string =>
  `d${Math.floor(blobIndex / SHARD_SIZE)}/f${blobIndex}.dat`;

/** xorshift32 fill — high-entropy, reproducible, keyed by blob index. */
const blobContent = (blobIndex: number, bytes: number): Buffer => {
  const buf = Buffer.allocUnsafe(bytes);
  let state = (blobIndex + 1) >>> 0;
  for (let i = 0; i < bytes; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buf[i] = state & 0xff;
  }
  return buf;
};

const writeChunk = (stdin: Writable, chunk: string | Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    stdin.write(chunk, (err) => (err === null || err === undefined ? resolve() : reject(err)));
  });

/** Streams one `blob` record (mark + data) — shared by every fast-import strategy. */
const writeBlobEntry = async (stdin: Writable, mark: number, content: Buffer): Promise<void> => {
  await writeChunk(stdin, `blob\nmark :${mark}\ndata ${content.byteLength}\n`);
  await writeChunk(stdin, content);
  await writeChunk(stdin, '\n');
};

interface CommitEntry {
  readonly message: string;
  readonly timestamp: number;
  /** Pre-built `M <mode> :<mark> <path>\n` lines, one per changed path. */
  readonly changes: string;
  /**
   * Explicit parent commit-ish — required whenever this commit is written by
   * a fast-import invocation SEPARATE from the one that wrote the branch's
   * current tip (the `many-pack` strategy's one-import-per-pack shape):
   * every fast-import process starts with empty internal branch state, so
   * without `from` it treats an existing ref's next commit as parentless and
   * refuses the resulting non-fast-forward update.
   */
  readonly from?: string;
}

/** Streams one `commit` record on `refs/heads/main` — shared by every fast-import strategy. */
const writeCommitEntry = async (stdin: Writable, entry: CommitEntry): Promise<void> => {
  let header = 'commit refs/heads/main\n';
  header += `author ${AUTHOR} ${entry.timestamp} +0000\n`;
  header += `committer ${AUTHOR} ${entry.timestamp} +0000\n`;
  header += `data ${Buffer.byteLength(entry.message)}\n${entry.message}`;
  if (entry.from !== undefined) header += `from ${entry.from}\n`;
  header += entry.changes;
  await writeChunk(stdin, header);
};

/** Streams a `git fast-import` script: every commit adds BLOBS_PER_COMMIT files. */
const streamFastImport = async (stdin: Writable, spec: FixtureSpec): Promise<void> => {
  for (let commit = 0; commit < spec.commits; commit += 1) {
    const firstBlob = commit * BLOBS_PER_COMMIT;
    let changes = '';
    for (let n = 0; n < BLOBS_PER_COMMIT; n += 1) {
      const blobIndex = firstBlob + n;
      await writeBlobEntry(stdin, blobIndex + 1, blobContent(blobIndex, spec.blobBytes));
      changes += `M 100644 :${blobIndex + 1} ${blobPath(blobIndex)}\n`;
    }
    await writeCommitEntry(stdin, {
      message: `commit ${commit}\n`,
      timestamp: BASE_TIMESTAMP + commit,
      changes,
    });
  }
};

const EVOLVING_PATH = 'evolving.dat';
// ~1% of bytes flipped per commit — enough drift that repack keeps
// deltifying (never falls back to a literal copy) while still sharing most
// of each commit's content with its predecessor, so chains grow deep.
const EVOLVING_MUTATION_RATE = 0.01;

/** xorshift32 stream, seeded once, advanced across mutate calls (closure-encapsulated state). */
const makeXorshift32 = (seed: number): (() => number) => {
  let state = (seed + 1) >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
};

const mutateEvolvingContent = (previous: Buffer, next: () => number): Buffer => {
  const buf = Buffer.from(previous);
  const flips = Math.max(1, Math.round(buf.byteLength * EVOLVING_MUTATION_RATE));
  for (let i = 0; i < flips; i += 1) {
    const offset = next() % buf.byteLength;
    buf[offset] = next() & 0xff;
  }
  return buf;
};

/**
 * Streams a `git fast-import` script that re-writes ONE path (`evolving.dat`)
 * every commit, each version a small mutation of the last. A single evolving
 * file — rather than many fresh ones — is what gives `git repack` a long
 * chain of similar objects to deltify against.
 */
const streamEvolvingFastImport = async (stdin: Writable, spec: FixtureSpec): Promise<void> => {
  const next = makeXorshift32(0);
  let content = blobContent(0, spec.blobBytes);
  for (let commit = 0; commit < spec.commits; commit += 1) {
    if (commit > 0) content = mutateEvolvingContent(content, next);
    const mark = commit + 1;
    await writeBlobEntry(stdin, mark, content);
    await writeCommitEntry(stdin, {
      message: `evolve ${commit}\n`,
      timestamp: BASE_TIMESTAMP + commit,
      changes: `M 100644 :${mark} ${EVOLVING_PATH}\n`,
    });
  }
};

const STABLE_PATH = 'stable.txt';
const CHURN_PATH = 'churn.txt';

/**
 * Streams a `git fast-import` script mirroring `fixtures.ts`'s
 * `setupDeepAncestryRepo` topology: commit 0 seeds `stable.txt` once, then
 * commits `1..spec.commits` each rewrite `churn.txt`. `stable.txt`'s history
 * stops at the root of an otherwise-deep ancestry — the O(path-depth)
 * unchanged-file shape `blame`'s TREESAME skip targets.
 */
const streamDeepAncestryFastImport = async (stdin: Writable, spec: FixtureSpec): Promise<void> => {
  await writeBlobEntry(stdin, 1, blobContent(0, spec.blobBytes));
  await writeCommitEntry(stdin, {
    message: 'seed stable.txt\n',
    timestamp: BASE_TIMESTAMP,
    changes: `M 100644 :1 ${STABLE_PATH}\n`,
  });

  for (let commit = 1; commit <= spec.commits; commit += 1) {
    const mark = commit + 1;
    await writeBlobEntry(stdin, mark, blobContent(commit, spec.blobBytes));
    await writeCommitEntry(stdin, {
      message: `churn ${commit - 1}\n`,
      timestamp: BASE_TIMESTAMP + commit,
      changes: `M 100644 :${mark} ${CHURN_PATH}\n`,
    });
  }
};

/**
 * Pure parser for `git verify-pack -v` output. Deltified blob lines carry a
 * chain-depth column (6+ whitespace-separated tokens); base blob lines and
 * non-blob lines (commit/tree, header/footer, `chain length = N:` histogram)
 * do not, so they are excluded by the token-count + `blob` filter. Returns
 * the oid of the deltified blob line with the maximum chain depth.
 */
export const maxChainDepthOid = (verifyPackOutput: string): string => {
  let deepestOid: string | undefined;
  let deepestDepth = -1;
  for (const line of verifyPackOutput.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[1] !== 'blob' || tokens.length < 6) continue;
    const depth = Number(tokens[5]);
    if (depth <= deepestDepth) continue;
    deepestDepth = depth;
    deepestOid = tokens[0];
  }
  if (deepestOid === undefined) {
    throw new Error('verify-pack output has no deltified blob lines');
  }
  return deepestOid;
};

// Child env with every GIT_* var stripped. A husky hook (or a parent `git`) can
// export GIT_DIR/GIT_WORK_TREE, which take precedence over `-C <repoDir>` and would
// silently redirect these subprocesses to the wrong repository.
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const runGit = async (repoDir: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout.trim();
};

const assertGitAvailable = async (): Promise<void> => {
  try {
    await execFileAsync('git', ['--version'], { env: gitEnv() });
  } catch {
    throw new FixtureUnavailableError('the `git` CLI is not on PATH');
  }
};

const runFastImport = async (
  repoDir: string,
  spec: FixtureSpec,
  stream: (stdin: Writable, spec: FixtureSpec) => Promise<void>,
): Promise<void> => {
  const importer = spawn('git', ['-C', repoDir, 'fast-import', '--quiet'], {
    stdio: ['pipe', 'ignore', 'inherit'],
    env: gitEnv(),
  });
  const stdin = importer.stdin;
  if (stdin === null) throw new Error('git fast-import: stdin pipe unavailable');
  const finished = new Promise<void>((resolve, reject) => {
    importer.on('error', reject);
    importer.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git fast-import exited with ${code}`)),
    );
  });
  try {
    await stream(stdin, spec);
    stdin.end();
    await finished;
  } catch (err) {
    // If a write failed (EPIPE from a crashed importer), `finished` would
    // reject too — observe it so the rejection is never unhandled.
    stdin.destroy();
    await finished.catch(() => undefined);
    throw err;
  }
};

/** Locates the (single, post-repack) pack index inside a fixture repo. */
const packIndexPath = async (repoDir: string): Promise<string> => {
  const packDir = await runGit(repoDir, ['rev-parse', '--git-path', 'objects/pack']);
  const absolutePackDir = path.isAbsolute(packDir) ? packDir : path.join(repoDir, packDir);
  const files = await readdir(absolutePackDir);
  const idx = files.find((f) => f.endsWith('.idx'));
  if (idx === undefined) throw new Error(`no pack .idx found under ${absolutePackDir}`);
  return path.join(absolutePackDir, idx);
};

/**
 * git deltifies backwards in time — HEAD's content is stored as the
 * depth-1 base, and the deepest chain link is an OLDER version reached by
 * repeatedly reversing a delta. So the deepest-chain object must come from
 * `verify-pack -v`, never from `rev-parse HEAD:<path>`.
 */
const deepestChainBlobId = async (repoDir: string): Promise<string> => {
  const idxPath = await packIndexPath(repoDir);
  const output = await runGit(repoDir, ['verify-pack', '-v', idxPath]);
  return maxChainDepthOid(output);
};

const generateEvolving = async (repoDir: string, spec: FixtureSpec): Promise<void> => {
  if (spec.deltaDepth === undefined || spec.deltaWindow === undefined) {
    throw new Error('evolving strategy requires deltaDepth and deltaWindow');
  }
  await runFastImport(repoDir, spec, streamEvolvingFastImport);
  await runGit(repoDir, ['checkout', '-f', 'main']);
  // -f forces a full recompute so --depth/--window actually apply (an
  // incremental repack would otherwise reuse the existing delta choices).
  await runGit(repoDir, [
    'repack',
    '-adf',
    `--depth=${spec.deltaDepth}`,
    `--window=${spec.deltaWindow}`,
    '--quiet',
  ]);
};

const generatePacked = async (
  repoDir: string,
  spec: FixtureSpec,
  stream: (stdin: Writable, spec: FixtureSpec) => Promise<void>,
): Promise<void> => {
  await runFastImport(repoDir, spec, stream);
  await runGit(repoDir, ['checkout', '-f', 'main']);
  await runGit(repoDir, ['repack', '-ad', '--quiet']);
};

/** Streams one commit that adds a single blob at `blobPath(blobIndex)` — the many-pack strategy's per-pack unit, one such commit per pack built. `fromCommit` chains it onto the branch's current tip across separate fast-import invocations. */
const streamManyPackCommit = async (
  stdin: Writable,
  blobIndex: number,
  spec: FixtureSpec,
  fromCommit: string | undefined,
): Promise<void> => {
  await writeBlobEntry(stdin, blobIndex + 1, blobContent(blobIndex, spec.blobBytes));
  await writeCommitEntry(stdin, {
    message: `pack ${blobIndex}\n`,
    timestamp: BASE_TIMESTAMP + blobIndex,
    changes: `M 100644 :${blobIndex + 1} ${blobPath(blobIndex)}\n`,
    ...(fromCommit !== undefined ? { from: fromCommit } : {}),
  });
};

/** `.keep`-guards every existing pack so the next `repack -dq` leaves them untouched and produces exactly one new pack for whatever is freshly loose. */
const keepExistingPacks = async (repoDir: string): Promise<void> => {
  const packDir = path.join(repoDir, '.git', 'objects', 'pack');
  const entries = await readdir(packDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.pack'))
      .map((entry) => writeFile(path.join(packDir, `${entry.slice(0, -'.pack'.length)}.keep`), '')),
  );
};

/**
 * Builds `spec.packs` separate packs, one committed blob apiece: the first
 * via `repack -adq`, every subsequent one via the `.keep`-guard +
 * `repack -dq` recipe (mirrors `midx-fixture-helpers.ts`'s
 * `repackIntoNewPack`), so pack 0 holds `blobPath(0)` (the "first pack" hit
 * target) and the last pack holds `blobPath(spec.packs - 1)` (the "last
 * pack" hit target) — the fixed positions the lookup bench needs.
 * `spec.packs === 0` leaves the sole blob loose, for the assertLoadable-gate
 * fixture. Writes a flat multi-pack-index afterward when `spec.midx` is true.
 */
const generateManyPack = async (repoDir: string, spec: FixtureSpec): Promise<void> => {
  const packCount = spec.packs;
  if (packCount === undefined || packCount < 0) {
    throw new Error('many-pack strategy requires spec.packs to be at least 0');
  }
  if (packCount === 0) {
    await runFastImport(repoDir, spec, (stdin) => streamManyPackCommit(stdin, 0, spec, undefined));
    await runGit(repoDir, ['checkout', '-f', 'main']);
    return;
  }
  let fromCommit: string | undefined;
  for (let i = 0; i < packCount; i += 1) {
    await runFastImport(repoDir, spec, (stdin) => streamManyPackCommit(stdin, i, spec, fromCommit));
    if (i === 0) {
      await runGit(repoDir, ['repack', '-adq']);
    } else {
      await keepExistingPacks(repoDir);
      await runGit(repoDir, ['repack', '-dq']);
    }
    fromCommit = await runGit(repoDir, ['rev-parse', 'refs/heads/main']);
  }
  await runGit(repoDir, ['checkout', '-f', 'main']);
  if (spec.midx === true) {
    await runGit(repoDir, ['multi-pack-index', 'write']);
  }
};

const runGenerateStrategy = async (repoDir: string, spec: FixtureSpec): Promise<void> => {
  if (spec.strategy === 'evolving') return generateEvolving(repoDir, spec);
  if (spec.strategy === 'deep-ancestry')
    return generatePacked(repoDir, spec, streamDeepAncestryFastImport);
  if (spec.strategy === 'many-pack') return generateManyPack(repoDir, spec);
  return generatePacked(repoDir, spec, streamFastImport);
};

/** `stable.txt` (deep-ancestry) is present at HEAD throughout the ancestry, unlike the deepest-chain object (evolving), which git stores as an OLDER version. */
const firstBlobIdFor = async (repoDir: string, spec: FixtureSpec): Promise<string> => {
  if (spec.strategy === 'evolving') return deepestChainBlobId(repoDir);
  if (spec.strategy === 'deep-ancestry')
    return runGit(repoDir, ['rev-parse', `HEAD:${STABLE_PATH}`]);
  return runGit(repoDir, ['rev-parse', `HEAD:${blobPath(0)}`]);
};

/** The blob committed into the last pack `generateManyPack` built — undefined for every other strategy and for the loose-only (`packs === 0`) shape. */
const lastBlobIdFor = async (repoDir: string, spec: FixtureSpec): Promise<string | undefined> => {
  if (spec.strategy !== 'many-pack' || spec.packs === undefined || spec.packs < 1) {
    return undefined;
  }
  return runGit(repoDir, ['rev-parse', `HEAD:${blobPath(spec.packs - 1)}`]);
};

const generateInto = async (repoDir: string, spec: FixtureSpec): Promise<FixtureMeta> => {
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '--initial-branch=main', '--quiet']);
  await runGenerateStrategy(repoDir, spec);
  if (spec.commitGraph === true) {
    await runGit(repoDir, ['commit-graph', 'write', '--reachable']);
  }

  const headCommitId = await runGit(repoDir, ['rev-parse', 'HEAD']);
  const firstBlobId = await firstBlobIdFor(repoDir, spec);
  const lastBlobId = await lastBlobIdFor(repoDir, spec);
  return {
    version: FIXTURE_GENERATOR_VERSION,
    headCommitId,
    firstBlobId,
    spec,
    ...(lastBlobId !== undefined ? { lastBlobId } : {}),
  };
};

const readCachedMeta = async (cacheDir: string): Promise<FixtureMeta | undefined> => {
  try {
    const raw = await readFile(path.join(cacheDir, 'meta.json'), 'utf8');
    const meta = JSON.parse(raw) as FixtureMeta;
    return meta.version === FIXTURE_GENERATOR_VERSION ? meta : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Returns the cached fixture, generating it on first use. Throws
 * `FixtureUnavailableError` when `git` is absent so benches can `skipIf`.
 *
 * Concurrency-safe: the fixture is built in a unique temp directory and
 * atomically renamed into place. A losing race (target already exists)
 * discards the temp build and reuses the winner's cache.
 */
export const ensureScaledFixture = async (spec: FixtureSpec): Promise<ScaledFixture> => {
  const cacheDir = cacheDirFor(spec);
  const cached = await readCachedMeta(cacheDir);
  if (cached !== undefined) {
    return {
      cwd: cacheDir,
      headCommitId: cached.headCommitId,
      firstBlobId: cached.firstBlobId,
      spec,
      ...(cached.lastBlobId !== undefined ? { lastBlobId: cached.lastBlobId } : {}),
    };
  }

  await assertGitAvailable();
  await mkdir(cacheRoot(), { recursive: true });
  const tmpDir = `${cacheDir}.tmp.${process.pid}.${Date.now()}`;
  let meta: FixtureMeta;
  try {
    meta = await generateInto(tmpDir, spec);
    await writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(meta), 'utf8');
    await rename(tmpDir, cacheDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    const won = await readCachedMeta(cacheDir);
    if (won === undefined) throw err;
    meta = won;
  }
  return {
    cwd: cacheDir,
    headCommitId: meta.headCommitId,
    firstBlobId: meta.firstBlobId,
    spec,
    ...(meta.lastBlobId !== undefined ? { lastBlobId: meta.lastBlobId } : {}),
  };
};

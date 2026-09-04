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
export const FIXTURE_GENERATOR_VERSION = 3;

const BLOBS_PER_COMMIT = 4;
const SHARD_SIZE = 512;
const AUTHOR = 'tsgit bench <bench@tsgit.invalid>';
const BASE_TIMESTAMP = 1_700_000_000;

export interface FixtureSpec {
  readonly label:
    | 'small'
    | 'small-fat-blob'
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

// Same commit/tree/blob COUNT as SMALL_FIXTURE — only blobBytes differs, so
// graph metadata is held constant and blob content is the sole variable
// (25× SMALL_FIXTURE's 2 560 B ≈ 13 MB total, still trivial to generate and
// well inside bench.yml's 30-minute nightly budget).
const SMALL_FAT_BLOB_BYTES = 65_536;

export const SMALL_FAT_BLOB_FIXTURE: FixtureSpec = {
  ...SMALL_FIXTURE,
  label: 'small-fat-blob',
  blobBytes: SMALL_FAT_BLOB_BYTES,
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
  /** Cached repo path. Never delete or mutate it — it is the shared cache; copy it first
   * (`fixture-scratch.ts`). */
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

/** Thrown when the `git` CLI is absent. */
class FixtureUnavailableError extends Error {
  constructor(reason: string) {
    super(`scaled bench fixture unavailable: ${reason}`);
    this.name = 'FixtureUnavailableError';
  }
}

/** The one condition a bench may skip on. Every other failure must reach the runner. */
export const isFixtureUnavailable = (err: unknown): boolean =>
  err instanceof FixtureUnavailableError;

export const cacheRoot = (): string => {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.cache');
  // Absolute on purpose: git silently ignores a relative discovery ceiling.
  return path.resolve(base, 'tsgit-bench');
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

// Isolated, deliberately non-existent HOME (and XDG config home) plus
// GIT_CONFIG_NOSYSTEM: a spawned `git` must never read the developer's global or
// system config. The identity probe below can retire a cache directory on its
// verdict, so a `safe.directory` or `core.*` setting must not be able to steer
// it — the same isolation class as the interop suite and `write-scratch.ts`.
const ISOLATED_GIT_HOME = path.join(os.tmpdir(), 'tsgit-bench-fixture-nonexistent-home');

// Child env with every GIT_* var stripped. A husky hook (or a parent `git`) can
// export GIT_DIR/GIT_WORK_TREE, which take precedence over `-C <repoDir>` and would
// silently redirect these subprocesses to the wrong repository.
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  HOME: ISOLATED_GIT_HOME,
  XDG_CONFIG_HOME: ISOLATED_GIT_HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  // Discovery must never walk above the cache root: a cache directory whose
  // `.git` is gutted would otherwise be answered by an ancestor repository.
  GIT_CEILING_DIRECTORIES: cacheRoot(),
});

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const errorCodeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;
const REASON_MAX_CHARS = 200;

/** One bounded printable line: bytes from a file a bench rewrote must not reach the terminal raw. */
const oneLine = (text: string): string =>
  Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code >= PRINTABLE_MIN && code <= PRINTABLE_MAX ? ch : '?';
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX_CHARS);

const runGit = async (repoDir: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout.trim();
};

const PRISTINE_HEAD_NAME = 'refs/heads/main';
const HEAD_FILE_PRISTINE = `ref: ${PRISTINE_HEAD_NAME}`;
const OID_HEX = /^[0-9a-f]{40,64}$/;
// `rev-parse --verify -q` answers "no" with exit 1 — a fact about the
// repository. Any other non-zero exit means git could not run at all.
const GIT_ANSWERED_NO = 1;

interface GitProbe {
  readonly code: number;
  readonly stdout: string;
  readonly detail: string;
}

const exitCodeOf = (err: unknown): number =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number'
    ? err.code
    : Number.NaN;

const stdoutOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'stdout' in err && typeof err.stdout === 'string'
    ? err.stdout.trim()
    : '';

/** Runs a quiet git query and reports its exit code instead of rejecting on it. */
const probeGit = async (repoDir: string, args: ReadonlyArray<string>): Promise<GitProbe> => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], { env: gitEnv() });
    return { code: 0, stdout: stdout.trim(), detail: '' };
  } catch (err) {
    return { code: exitCodeOf(err), stdout: stdoutOf(err), detail: errorMessage(err) };
  }
};

const gitAnswered = (probe: GitProbe): boolean =>
  probe.code === 0 || probe.code === GIT_ANSWERED_NO;

type CacheVerdict =
  | { readonly kind: 'pristine' }
  | { readonly kind: 'mismatch'; readonly reason: string }
  | { readonly kind: 'unverifiable'; readonly reason: string };

const mismatch = (reason: string): CacheVerdict => ({ kind: 'mismatch', reason });
const unverifiable = (reason: string): CacheVerdict => ({ kind: 'unverifiable', reason });
const orWord = (answer: string, word: string): string => (answer === '' ? word : answer);

const HEAD_EXCERPT_CHARS = 80;

const describeHead = (content: string): string => {
  const flat = oneLine(content);
  if (OID_HEX.test(flat)) return 'detached';
  if (flat.startsWith('ref: ')) return flat.slice('ref: '.length);
  return `"${flat.slice(0, HEAD_EXCERPT_CHARS)}"`;
};

// The file itself being absent is a fact about the directory; any other read
// failure is the prober's, and a prober failure never authorises a rebuild.
const MISSING_FILE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/**
 * What `.git/HEAD` says, read without git. Every strategy ends with
 * `checkout -f main`, so a pristine fixture's HEAD file is exactly
 * `ref: refs/heads/main`; anything else — a detached oid, another ref, garbage,
 * or no file at all — is a fact about the directory, never a probe failure.
 */
const headFileVerdict = async (cacheDir: string): Promise<CacheVerdict | undefined> => {
  try {
    const content = (await readFile(path.join(cacheDir, '.git', 'HEAD'), 'utf8')).trim();
    if (content === HEAD_FILE_PRISTINE) return undefined;
    return mismatch(`HEAD is ${describeHead(content)}, expected ${PRISTINE_HEAD_NAME}`);
  } catch (err) {
    const code = errorCodeOf(err);
    if (code !== undefined && MISSING_FILE_CODES.has(code)) {
      return mismatch(`HEAD file is missing: ${errorMessage(err)}`);
    }
    return unverifiable(`HEAD file could not be read: ${errorMessage(err)}`);
  }
};

/**
 * Identity of a cached repo against what the generator wrote: the HEAD file
 * must name `refs/heads/main`, and that ref must be the recorded tip. A
 * mismatch is only ever declared from a fact — the HEAD file's content, or an
 * answer git actually gave (`--verify -q` exits 1 for a missing ref). A probe
 * git could not execute (dubious ownership, a transient spawn failure, no git
 * at all) is unverifiable, and an unverifiable cache is never destroyed.
 */
const readCacheVerdict = async (cacheDir: string, meta: FixtureMeta): Promise<CacheVerdict> => {
  const head = await headFileVerdict(cacheDir);
  if (head !== undefined) return head;
  const main = await probeGit(cacheDir, [
    'rev-parse',
    '--verify',
    '-q',
    `${PRISTINE_HEAD_NAME}^{commit}`,
  ]);
  if (!gitAnswered(main)) return unverifiable(main.detail);
  if (main.stdout !== meta.headCommitId) {
    return mismatch(
      `${PRISTINE_HEAD_NAME} is ${orWord(main.stdout, 'missing')}, expected ${meta.headCommitId}`,
    );
  }
  return { kind: 'pristine' };
};

/** Predicate half of `assertGitAvailable`, which is its throwing wrapper. */
const gitAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync('git', ['--version'], { env: gitEnv() });
    return true;
  } catch {
    return false;
  }
};

/** The `ScaledFixture` handed to benches; `lastBlobId` is present only when the meta carries one. */
export const toScaledFixture = (
  cacheDir: string,
  meta: FixtureMeta,
  spec: FixtureSpec,
): ScaledFixture => ({
  cwd: cacheDir,
  headCommitId: meta.headCommitId,
  firstBlobId: meta.firstBlobId,
  spec,
  ...(meta.lastBlobId !== undefined ? { lastBlobId: meta.lastBlobId } : {}),
});

const assertGitAvailable = async (): Promise<void> => {
  if (!(await gitAvailable())) throw new FixtureUnavailableError('the `git` CLI is not on PATH');
};

export type LeftoverKind = 'tmp' | 'corrupt';

/**
 * The two transient siblings the generator writes next to a cache directory: a
 * build in flight (`tmp`) and a retired cache on its way out (`corrupt`).
 * `fixture-prune.ts` parses exactly this shape to reclaim abandoned ones.
 */
export const leftoverDirName = (
  cacheDir: string,
  kind: LeftoverKind,
  pid: number = process.pid,
  stamp: number = Date.now(),
): string => `${cacheDir}.${kind}.${pid}.${stamp}`;

/** Moves a non-pristine cache aside atomically, then removes it. A no-op when absent. */
const retireCacheDir = async (cacheDir: string): Promise<void> => {
  const retired = leftoverDirName(cacheDir, 'corrupt');
  try {
    await rename(cacheDir, retired);
  } catch (err) {
    if (errorCodeOf(err) !== 'ENOENT') throw err;
    return; // absent, or another process already retired it
  }
  await rm(retired, { recursive: true, force: true });
};

const warnNotPristine = (spec: FixtureSpec, reason: string): void => {
  process.stderr.write(
    `[bench] cached fixture "${spec.label}" is not pristine: ${oneLine(reason)}. Rebuilding it. ` +
      `A bench mutated the shared cache — copy it first ` +
      `(test/bench/support/fixture-scratch.ts).\n`,
  );
};

const warnUnverifiable = (spec: FixtureSpec, cacheDir: string, reason: string): void => {
  process.stderr.write(
    `[bench] cached fixture "${spec.label}" could not be verified: ` +
      `${oneLine(reason)}. Keeping it — a mismatch is never assumed; ` +
      `delete ${cacheDir} to force a rebuild.\n`,
  );
};

/** With no git at all the cache is handed out silently, exactly as before the probe existed. */
const reportUnverified = async (
  spec: FixtureSpec,
  cacheDir: string,
  reason: string,
): Promise<void> => {
  if (await gitAvailable()) warnUnverifiable(spec, cacheDir, reason);
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

interface InspectedCache {
  readonly meta: FixtureMeta;
  readonly verdict: CacheVerdict;
}

/** The cached meta plus its identity verdict, or `undefined` when no usable `meta.json` exists. */
const inspectCache = async (cacheDir: string): Promise<InspectedCache | undefined> => {
  const meta = await readCachedMeta(cacheDir);
  if (meta === undefined) return undefined;
  return { meta, verdict: await readCacheVerdict(cacheDir, meta) };
};

/** Hands out a pristine cache, or an unverifiable one — saying so when git could have answered. */
const trustCached = async (
  cacheDir: string,
  cached: InspectedCache,
  spec: FixtureSpec,
): Promise<ScaledFixture> => {
  if (cached.verdict.kind === 'unverifiable') {
    await reportUnverified(spec, cacheDir, cached.verdict.reason);
  }
  return toScaledFixture(cacheDir, cached.meta, spec);
};

/** Cleanup must never replace the build failure with its own error. */
const discardTempBuild = async (tmpDir: string): Promise<void> => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch (cleanupErr) {
    process.stderr.write(`[bench] could not remove ${tmpDir}: ${errorMessage(cleanupErr)}\n`);
  }
};

/** A losing race reuses the winner's cache — but only a winner that passes the same probe. */
const reuseWinnerOrRethrow = async (
  cacheDir: string,
  spec: FixtureSpec,
  err: unknown,
): Promise<FixtureMeta> => {
  const winner = await inspectCache(cacheDir);
  if (winner === undefined || winner.verdict.kind === 'unverifiable') throw err;
  if (winner.verdict.kind === 'mismatch') {
    warnNotPristine(spec, winner.verdict.reason);
    throw err;
  }
  return winner.meta;
};

/** Builds into a unique temp directory and renames it into place. */
const buildIntoCache = async (cacheDir: string, spec: FixtureSpec): Promise<FixtureMeta> => {
  const tmpDir = leftoverDirName(cacheDir, 'tmp');
  try {
    const meta = await generateInto(tmpDir, spec);
    await writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(meta), 'utf8');
    await rename(tmpDir, cacheDir);
    return meta;
  } catch (err) {
    await discardTempBuild(tmpDir);
    return reuseWinnerOrRethrow(cacheDir, spec, err);
  }
};

const rebuildCache = async (cacheDir: string, spec: FixtureSpec): Promise<ScaledFixture> => {
  // Re-inspect right before retiring: a concurrent build may have renamed a
  // pristine cache into place since the first look, and only a proven-pristine
  // winner may override a retire this path already has evidence for.
  const winner = await inspectCache(cacheDir);
  if (winner !== undefined && winner.verdict.kind === 'pristine') {
    return toScaledFixture(cacheDir, winner.meta, spec);
  }
  // Retiring is unconditional past this point: it also clears a directory that
  // exists with no readable `meta.json`, which the final `rename` would otherwise
  // hit as ENOTEMPTY.
  await retireCacheDir(cacheDir);
  await mkdir(cacheRoot(), { recursive: true });
  const meta = await buildIntoCache(cacheDir, spec);
  return toScaledFixture(cacheDir, meta, spec);
};

/**
 * Returns the cached fixture, generating it on first use. Throws
 * `FixtureUnavailableError` when `git` is absent and a build is needed, so benches
 * can `skipIf`.
 *
 * A cache hit is trusted only after its identity is probed (see
 * `readCacheVerdict`): a proven mismatch is retired and rebuilt with a warning; a
 * cache git could not verify is kept and reported. Concurrency-safe: the fixture
 * is built in a unique temp directory and atomically renamed into place, and a
 * losing race reuses the winner's cache once it passes the same probe.
 */
export const ensureScaledFixture = async (spec: FixtureSpec): Promise<ScaledFixture> => {
  const cacheDir = cacheDirFor(spec);
  const cached = await inspectCache(cacheDir);
  if (cached !== undefined) {
    if (cached.verdict.kind !== 'mismatch') return trustCached(cacheDir, cached, spec);
    warnNotPristine(spec, cached.verdict.reason);
  }
  // git first: never destroy a cache directory we could not rebuild.
  await assertGitAvailable();
  return rebuildCache(cacheDir, spec);
};

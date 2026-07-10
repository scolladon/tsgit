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
const FIXTURE_GENERATOR_VERSION = 1;

const BLOBS_PER_COMMIT = 4;
const SHARD_SIZE = 512;
const AUTHOR = 'tsgit bench <bench@tsgit.invalid>';
const BASE_TIMESTAMP = 1_700_000_000;

export interface FixtureSpec {
  readonly label: 'medium' | 'large' | 'delta-chain';
  readonly strategy: 'multi' | 'evolving';
  readonly commits: number;
  /** Led by strategy; for 'evolving' this is NOT a file count. */
  readonly blobs: number;
  readonly blobBytes: number;
  /** `git repack --depth`, evolving strategy only. */
  readonly deltaDepth?: number;
  /** `git repack --window`, evolving strategy only. */
  readonly deltaWindow?: number;
}

export const MEDIUM_FIXTURE: FixtureSpec = {
  label: 'medium',
  strategy: 'multi',
  commits: 5_000,
  blobs: 20_000,
  blobBytes: 2_560,
};

export const LARGE_FIXTURE: FixtureSpec = {
  label: 'large',
  strategy: 'multi',
  commits: 50_000,
  blobs: 200_000,
  blobBytes: 2_560,
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

export interface ScaledFixture {
  /** Cached repo path. Never delete it — it is the cache. */
  readonly cwd: string;
  readonly headCommitId: string;
  readonly firstBlobId: string;
  readonly spec: FixtureSpec;
}

interface FixtureMeta {
  readonly version: number;
  readonly headCommitId: string;
  readonly firstBlobId: string;
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

/** Streams a `git fast-import` script: every commit adds BLOBS_PER_COMMIT files. */
const streamFastImport = async (stdin: Writable, spec: FixtureSpec): Promise<void> => {
  for (let commit = 0; commit < spec.commits; commit += 1) {
    const firstBlob = commit * BLOBS_PER_COMMIT;
    for (let n = 0; n < BLOBS_PER_COMMIT; n += 1) {
      const blobIndex = firstBlob + n;
      const content = blobContent(blobIndex, spec.blobBytes);
      await writeChunk(stdin, `blob\nmark :${blobIndex + 1}\ndata ${content.byteLength}\n`);
      await writeChunk(stdin, content);
      await writeChunk(stdin, '\n');
    }
    const message = `commit ${commit}\n`;
    const ts = BASE_TIMESTAMP + commit;
    let header = 'commit refs/heads/main\n';
    header += `author ${AUTHOR} ${ts} +0000\n`;
    header += `committer ${AUTHOR} ${ts} +0000\n`;
    header += `data ${Buffer.byteLength(message)}\n${message}`;
    for (let n = 0; n < BLOBS_PER_COMMIT; n += 1) {
      const blobIndex = firstBlob + n;
      header += `M 100644 :${blobIndex + 1} ${blobPath(blobIndex)}\n`;
    }
    await writeChunk(stdin, header);
  }
};

const EVOLVING_PATH = 'evolving.dat';
// ~1% of bytes flipped per commit — enough drift that repack keeps
// deltifying (never falls back to a literal copy) while still sharing most
// of each commit's content with its predecessor, so chains grow deep.
const EVOLVING_MUTATION_RATE = 0.01;

/** xorshift32 stream, seeded once, reused across mutate calls (module-private PRNG state). */
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
    await writeChunk(stdin, `blob\nmark :${mark}\ndata ${content.byteLength}\n`);
    await writeChunk(stdin, content);
    await writeChunk(stdin, '\n');

    const message = `evolve ${commit}\n`;
    const ts = BASE_TIMESTAMP + commit;
    let header = 'commit refs/heads/main\n';
    header += `author ${AUTHOR} ${ts} +0000\n`;
    header += `committer ${AUTHOR} ${ts} +0000\n`;
    header += `data ${Buffer.byteLength(message)}\n${message}`;
    header += `M 100644 :${mark} ${EVOLVING_PATH}\n`;
    await writeChunk(stdin, header);
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

const runGit = async (repoDir: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

const assertGitAvailable = async (): Promise<void> => {
  try {
    await execFileAsync('git', ['--version']);
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

const generateMulti = async (repoDir: string, spec: FixtureSpec): Promise<void> => {
  await runFastImport(repoDir, spec, streamFastImport);
  await runGit(repoDir, ['checkout', '-f', 'main']);
  await runGit(repoDir, ['repack', '-ad', '--quiet']);
};

const generateInto = async (repoDir: string, spec: FixtureSpec): Promise<FixtureMeta> => {
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '--initial-branch=main', '--quiet']);

  if (spec.strategy === 'evolving') {
    await generateEvolving(repoDir, spec);
  } else {
    await generateMulti(repoDir, spec);
  }

  const headCommitId = await runGit(repoDir, ['rev-parse', 'HEAD']);
  const firstBlobId =
    spec.strategy === 'evolving'
      ? await deepestChainBlobId(repoDir)
      : await runGit(repoDir, ['rev-parse', `HEAD:${blobPath(0)}`]);
  return { version: FIXTURE_GENERATOR_VERSION, headCommitId, firstBlobId, spec };
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
  return { cwd: cacheDir, headCommitId: meta.headCommitId, firstBlobId: meta.firstBlobId, spec };
};

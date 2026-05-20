/**
 * Deterministic scaled-fixture generator (Phase 15.1 / 15.2).
 *
 * Builds a medium (5k commits / 20k blobs / ~50 MB) or large (50k / 200k /
 * ~500 MB) git repository via `git fast-import` and caches it under
 * `~/.cache/tsgit-bench`. Generation runs once; later calls are cache hits.
 *
 * See docs/adr/054-bench-fixture-generation-caching.md for the rationale
 * (fast-import speed, version-keyed cache, seeded-PRNG content, non-bare repo).
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  readonly label: 'medium' | 'large';
  readonly commits: number;
  readonly blobs: number;
  readonly blobBytes: number;
}

export const MEDIUM_FIXTURE: FixtureSpec = {
  label: 'medium',
  commits: 5_000,
  blobs: 20_000,
  blobBytes: 2_560,
};

export const LARGE_FIXTURE: FixtureSpec = {
  label: 'large',
  commits: 50_000,
  blobs: 200_000,
  blobBytes: 2_560,
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

const generateInto = async (repoDir: string, spec: FixtureSpec): Promise<FixtureMeta> => {
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ['init', '--initial-branch=main', '--quiet']);

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
  await streamFastImport(stdin, spec);
  stdin.end();
  await finished;

  await runGit(repoDir, ['checkout', '-f', 'main']);
  await runGit(repoDir, ['repack', '-ad', '--quiet']);

  const headCommitId = await runGit(repoDir, ['rev-parse', 'HEAD']);
  const firstBlobId = await runGit(repoDir, ['rev-parse', `HEAD:${blobPath(0)}`]);
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

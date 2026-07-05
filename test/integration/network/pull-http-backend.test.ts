/**
 * End-to-end `pull` against a local `git-http-backend` over Node's built-in
 * http server. Sibling of `fetch-http-backend.test.ts` / `push-http-backend.test.ts`:
 * clones the clone-source fixture with tsgit and runs `repo.pull()` (no args,
 * upstream resolved from the config `clone` now writes), proving that fetch +
 * merge compose over real git.
 *
 * Covers both the up-to-date path (remote unchanged after clone) and the
 * fast-forward path (remote advances past what was cloned, delivered via the
 * incremental fetch negotiation — see `incremental-fetch-http-backend.test.ts`
 * for the dedicated faithfulness pin). The true-merge / conflict / abort /
 * continue composition is proven exhaustively in
 * `test/unit/application/commands/pull.test.ts` against a real local commit
 * graph.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend`.
 *
 * @proves
 *   surface: pull
 *   bucket:  real-http
 *   unique:  pull composes fetch + merge over canonical git-http-backend
 */
import { spawn } from 'node:child_process';
import { accessSync, cpSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectId, RefName } from '../../../src/domain/objects/object-id.js';
import { openRepository } from '../../../src/index.node.js';
import { git, runGit, runGitEnv } from '../interop-helpers.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');

const findGitExecPath = (): string | undefined => {
  try {
    return runGit(['--exec-path']).trim();
  } catch {
    return undefined;
  }
};

const GIT_EXEC_PATH = findGitExecPath();
const GIT_HTTP_BACKEND = GIT_EXEC_PATH ? path.join(GIT_EXEC_PATH, 'git-http-backend') : undefined;
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    return true;
  } catch {
    return false;
  }
})();

const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');

const SKIP_REASON: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_HTTP_BACKEND === undefined
    ? 'git-http-backend not available — run scripts/regenerate-clone-fixtures.sh first'
    : !FIXTURE_AVAILABLE
      ? 'fixture missing — run scripts/regenerate-clone-fixtures.sh'
      : false;

const handleRequest = (
  backendPath: string,
  projectRoot: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  if (req.url === undefined || req.method === undefined) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const [pathInfo, queryString = ''] = req.url.split('?', 2);
  const env: NodeJS.ProcessEnv = {
    ...runGitEnv(),
    PATH_INFO: pathInfo ?? '/',
    QUERY_STRING: queryString,
    REQUEST_METHOD: req.method,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: req.headers['content-length'] ?? '',
    REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
  };
  const child = spawn(backendPath, [], { env });
  child.stdin.on('error', () => undefined);
  req.pipe(child.stdin);
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.on('close', () => writeCgiResponse(res, Buffer.concat(chunks)));
  child.on('error', (err) => {
    res.statusCode = 502;
    res.end(`CGI spawn error: ${err.message}`);
  });
};

const writeCgiResponse = (res: http.ServerResponse, raw: Buffer): void => {
  const sep = findHeaderSeparator(raw);
  if (sep < 0) {
    res.statusCode = 502;
    res.end('CGI response missing header separator');
    return;
  }
  const headerBuf = raw.subarray(0, sep);
  const body = raw.subarray(sep + (raw[sep] === 0x0d ? 4 : 2));
  res.statusCode = applyCgiHeaders(res, headerBuf);
  res.end(body);
};

const applyCgiHeaders = (res: http.ServerResponse, headerBuf: Buffer): number => {
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
    res.setHeader(key, value);
  }
  return statusCode;
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

describe.skipIf(SKIP_REASON !== false)('pull — end-to-end against git-http-backend', () => {
  let server: http.Server;
  let port: number;
  let serverProjectRoot: string;
  const workDirs: string[] = [];

  beforeAll(async () => {
    serverProjectRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pull-fixture-'));
    cpSync(SOURCE_GIT, path.join(serverProjectRoot, 'source.git'), { recursive: true });
    server = http.createServer((req, res) => {
      handleRequest(GIT_HTTP_BACKEND as string, serverProjectRoot, req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('server.address() returned an unexpected value');
    }
    port = addr.port;
  });

  afterAll(async () => {
    for (const dir of workDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    if (serverProjectRoot !== undefined) {
      await rm(serverProjectRoot, { recursive: true, force: true });
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('Given a clone whose remote has not moved, When pull, Then fetch + merge compose and report up-to-date', async () => {
    // Arrange — clone the fixture; clone writes the upstream tracking config
    // that the no-argument pull resolves.
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pull-it-'));
    workDirs.push(workDir);
    const url = `http://127.0.0.1:${port}/source.git`;
    const repo = await openRepository({
      cwd: workDir,
      allowInsecureHttp: true,
      config: {
        allowInsecure: true,
        allowPrivateNetworks: true,
        dnsResolver: async () => ['127.0.0.1'],
      },
    });
    await repo.clone({ url });

    // Act
    const sut = await repo.pull();

    // Assert — fetch ran against the real backend and merge integrated cleanly.
    expect(sut.fetch.remote).toBe('origin');
    expect(sut.fetch.url).toBe(url);
    expect(sut.merge.kind).toBe('up-to-date');
  });

  it('Given a clone whose remote has advanced, When pull, Then fetch + merge compose and fast-forward', async () => {
    // Arrange — clone the fixture at its current (pre-advance) state.
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pull-ff-it-'));
    workDirs.push(workDir);
    const url = `http://127.0.0.1:${port}/source.git`;
    const repo = await openRepository({
      cwd: workDir,
      allowInsecureHttp: true,
      config: {
        allowInsecure: true,
        allowPrivateNetworks: true,
        dnsResolver: async () => ['127.0.0.1'],
      },
    });
    await repo.clone({ url });

    // Arrange — advance the served bare copy past what was cloned, via a
    // real-git worktree pushed straight into it on the local filesystem (no
    // HTTP involved in the advance itself, only in tsgit's later pull).
    const seedDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pull-ff-seed-'));
    workDirs.push(seedDir);
    const bareRepoPath = path.join(serverProjectRoot, 'source.git');
    git(seedDir, 'clone', '-q', bareRepoPath, '.');
    git(seedDir, 'config', 'user.name', 'Ada');
    git(seedDir, 'config', 'user.email', 'ada@example.com');
    await writeFile(path.join(seedDir, 'advance.txt'), 'advance\n');
    git(seedDir, 'add', 'advance.txt');
    git(seedDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'advance');
    git(seedDir, 'push', '-q', 'origin', 'HEAD:main');
    const c1 = git(seedDir, 'rev-parse', 'HEAD').trim() as ObjectId;

    // Act
    const sut = await repo.pull();

    // Assert — fetch delivered exactly the new commit and merge
    // fast-forwarded the local branch onto it (no `pull` code change needed
    // — it composes over the corrected fetch negotiation as-is).
    const mainUpdate = sut.fetch.updatedRefs.find(
      (r) => r.name === ('refs/remotes/origin/main' as RefName),
    );
    expect(mainUpdate?.newId).toBe(c1);
    expect(sut.merge).toEqual({
      kind: 'fast-forward',
      id: c1,
      branch: 'refs/heads/main' as RefName,
    });
  });
});

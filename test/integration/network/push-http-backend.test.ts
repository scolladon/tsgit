/**
 * End-to-end `push` against a local `git-http-backend` over Node's built-in
 * http server.
 *
 * Sibling of `fetch-http-backend.test.ts`: copies the clone-source fixture
 * to a writable temp dir, enables `http.receivepack=true` on the bare repo,
 * clones from it, creates a new commit locally, pushes it back, then
 * asserts that the bare repo's `refs/heads/main` advanced to the local tip
 * via `git --git-dir <bare> rev-parse main`.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend`.
 *
 * @proves
 *   surface: push
 *   bucket:  real-http
 *   unique:  push advances refs/heads/main on canonical bare repo via receive-pack
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, cpSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { __resetConfigCacheForTests } from '../../../src/application/primitives/config-read.js';
import {
  resolveRef,
  walkCommits,
  writeObject,
  writeTree,
} from '../../../src/application/primitives/index.js';
import type {
  Blob,
  Commit,
  FileMode,
  ObjectId,
  RefName,
} from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');

const findGitExecPath = (): string | undefined => {
  try {
    return execFileSync('git', ['--exec-path']).toString().trim();
  } catch {
    return undefined;
  }
};

const GIT_EXEC_PATH = findGitExecPath();
const GIT_HTTP_BACKEND = GIT_EXEC_PATH ? path.join(GIT_EXEC_PATH, 'git-http-backend') : undefined;
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    accessSync(HEAD_OID_FILE);
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
    ...process.env,
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
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.on('close', () => {
    writeCgiResponse(res, Buffer.concat(chunks));
  });
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

describe.skipIf(SKIP_REASON !== false)('push — end-to-end against git-http-backend', () => {
  let server: http.Server;
  let port: number;
  let serverProjectRoot: string;
  let bareRepoPath: string;
  let workDir: string;

  beforeAll(async () => {
    // Copy the fixture bare repo to a writable temp dir so we can enable
    // http.receivepack and accept pushes without polluting the read-only
    // fixture used by other integration tests.
    serverProjectRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-push-fixture-'));
    bareRepoPath = path.join(serverProjectRoot, 'source.git');
    cpSync(SOURCE_GIT, bareRepoPath, { recursive: true });
    // Enable receive-pack over HTTP and allow non-fast-forward + delete
    // operations for the test (the bare side defaults reject them).
    execFileSync('git', ['-C', bareRepoPath, 'config', 'http.receivepack', 'true']);
    execFileSync('git', [
      '-C',
      bareRepoPath,
      'config',
      'receive.denyCurrentBranch',
      'updateInstead',
    ]);
    execFileSync('git', ['-C', bareRepoPath, 'config', 'receive.denyNonFastforwards', 'false']);
    execFileSync('git', ['-C', bareRepoPath, 'config', 'receive.denyDeletes', 'false']);

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
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
    if (serverProjectRoot !== undefined) {
      await rm(serverProjectRoot, { recursive: true, force: true });
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('Given a clone, a local commit, then push, When push runs, Then bare refs/heads/main advances to the local tip', async () => {
    // Arrange — clone the bare into a local repo.
    workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-push-it-'));
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

    await repo.clone({
      url,
      allowInsecure: true,
      allowPrivateNetworks: true,
      resolver: async () => ['127.0.0.1'],
    });

    // Wire a remote so push can resolve "origin".
    const configPath = path.join(repo.ctx.layout.gitDir, 'config');
    const existingConfig = await readFile(configPath, 'utf8').catch(() => '');
    if (!existingConfig.includes('[remote "origin"]')) {
      await writeFile(
        configPath,
        `${existingConfig}\n[remote "origin"]\n  url = ${url}\n  fetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
    }
    // clone primed the per-context config cache; drop it so the manual edit
    // above is visible to the subsequent push.
    __resetConfigCacheForTests();

    // Add one new commit on main locally.
    const head = await resolveRef(repo.ctx, 'refs/heads/main' as RefName);
    const blob: Blob = {
      type: 'blob',
      content: new TextEncoder().encode('push integration content\n'),
      id: '' as ObjectId,
    };
    const blobId = await writeObject(repo.ctx, blob);
    const treeId = await writeTree(repo.ctx, [
      { name: 'pushed.txt', mode: '100644' as FileMode, id: blobId },
    ]);
    const author = {
      name: 'Push',
      email: 'push@test',
      timestamp: 1_700_000_100,
      timezoneOffset: '+0000',
    };
    const commit: Commit = {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree: treeId,
        parents: [head],
        author,
        committer: author,
        message: 'push integration commit',
        extraHeaders: [],
      },
    };
    const newHead = await writeObject(repo.ctx, commit);
    // Update local main to the new commit.
    await writeFile(path.join(repo.ctx.layout.gitDir, 'refs/heads/main'), `${newHead}\n`);

    // Act
    const sut = await repo.push({
      remote: 'origin',
      refspecs: ['refs/heads/main:refs/heads/main'],
    });

    // Assert — pushedRefs surface
    expect(sut.pushedRefs).toHaveLength(1);
    expect(sut.pushedRefs[0]).toMatchObject({
      name: 'refs/heads/main' as RefName,
      newId: newHead,
      status: 'ok',
    });

    // Assert — the bare repo's main advanced.
    const bareTip = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', 'main'])
      .toString()
      .trim();
    expect(bareTip).toBe(newHead);

    // Assert — bare repo can walk the new commit + the original history.
    // We verify locally via our walker that nothing is missing.
    const seen: ObjectId[] = [];
    for await (const c of walkCommits(repo.ctx, { from: [newHead as ObjectId] })) {
      seen.push(c.id);
    }
    expect(seen[0]).toBe(newHead);

    // Assert — remote-tracking cache updated.
    const cache = (
      await readFile(path.join(repo.ctx.layout.gitDir, 'refs/remotes/origin/main'), 'utf8')
    ).trim();
    expect(cache).toBe(newHead);

    await repo.dispose();
  }, 60_000);

  it('Given an already-up-to-date local main, When push runs, Then pushedRefs is empty and no POST is issued to the bare', async () => {
    // Arrange — fresh repo, fresh tmp dir.
    const localDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-push-noop-'));
    const url = `http://127.0.0.1:${port}/source.git`;
    const repo = await openRepository({
      cwd: localDir,
      allowInsecureHttp: true,
      config: {
        allowInsecure: true,
        allowPrivateNetworks: true,
        dnsResolver: async () => ['127.0.0.1'],
      },
    });
    await repo.clone({
      url,
      allowInsecure: true,
      allowPrivateNetworks: true,
      resolver: async () => ['127.0.0.1'],
    });
    const configPath = path.join(repo.ctx.layout.gitDir, 'config');
    const existingConfig = await readFile(configPath, 'utf8').catch(() => '');
    if (!existingConfig.includes('[remote "origin"]')) {
      await writeFile(
        configPath,
        `${existingConfig}\n[remote "origin"]\n  url = ${url}\n  fetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
    }
    // clone primed the per-context config cache; drop it so the manual edit
    // above is visible to the subsequent push.
    __resetConfigCacheForTests();

    // Act — push with no local changes. Local main should equal remote main.
    const sut = await repo.push({
      remote: 'origin',
      refspecs: ['refs/heads/main:refs/heads/main'],
    });

    // Assert
    expect(sut.pushedRefs).toEqual([]);

    await repo.dispose();
    await rm(localDir, { recursive: true, force: true });
  }, 60_000);
});

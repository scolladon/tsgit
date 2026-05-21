/**
 * End-to-end `fetch` against a local `git-http-backend` over Node's built-in
 * http server. Sibling of `clone-http-backend.test.ts`: clones first, then
 * runs `fetch` against the same fixture and asserts that the
 * `refs/remotes/origin/main` remote-tracking ref is at the fixture's HEAD oid
 * and that the full commit history is reachable from it.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { __resetConfigCacheForTests } from '../../../src/application/primitives/config-read.js';
import { walkCommits } from '../../../src/application/primitives/index.js';
import type { ObjectId, RefName } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');
const HEAD_HISTORY_FILE = path.join(FIXTURE_DIR, 'HEAD-history.txt');

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
    accessSync(HEAD_HISTORY_FILE);
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

describe.skipIf(SKIP_REASON !== false)('fetch — end-to-end against git-http-backend', () => {
  let server: http.Server;
  let port: number;
  let workDir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      handleRequest(GIT_HTTP_BACKEND as string, FIXTURE_DIR, req, res);
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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('Given a clone followed by fetch against the same fixture, When fetch runs, Then refs/remotes/origin/main is the fixture HEAD and history is reachable', async () => {
    // Arrange — clone first.
    workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fetch-it-'));
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

    // Write a config block so fetch can find the remote.
    const configPath = path.join(repo.ctx.layout.gitDir, 'config');
    const existingConfig = await readFile(configPath, 'utf8').catch(() => '');
    if (!existingConfig.includes('[remote "origin"]')) {
      await writeFile(
        configPath,
        `${existingConfig}\n[remote "origin"]\n  url = ${url}\n  fetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
    }
    // clone primed the per-context config cache; drop it so the manual edit
    // above is visible to the subsequent fetch.
    __resetConfigCacheForTests();

    // Act
    const sut = await repo.fetch({ remote: 'origin' });

    // Assert — result surface
    expect(sut.remote).toBe('origin');
    expect(sut.url).toBe(url);
    const mainUpdate = sut.updatedRefs.find(
      (r) => r.name === ('refs/remotes/origin/main' as RefName),
    );
    expect(mainUpdate).toBeDefined();

    // Assert — on-disk ref + reachable history
    const expectedHead = (await readFile(HEAD_OID_FILE, 'utf8')).trim() as ObjectId;
    expect(mainUpdate?.newId).toBe(expectedHead);
    const history = (await readFile(HEAD_HISTORY_FILE, 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => line.length > 0) as ObjectId[];
    const walker = walkCommits(repo.ctx, { from: [expectedHead] });
    const seen: ObjectId[] = [];
    for await (const commit of walker) {
      seen.push(commit.id);
    }
    // Walker yields newest-first; HEAD-history.txt is oldest → newest.
    expect(seen.length).toBe(history.length);
    expect([...seen].reverse()).toEqual(history);

    await repo.dispose();
  }, 30_000);
});

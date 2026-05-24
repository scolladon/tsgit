/**
 * End-to-end shallow clone against a local `git-http-backend` running over
 * Node's built-in http server. Verifies that the prior acceptance bullet
 * holds:
 *
 *  shallow + non-shallow fetch updates refs/remotes/<remote>/* and writes
 *  received objects.
 *
 * This sibling of `clone-http-backend.test.ts` exercises the shallow path:
 * `clone({ url, depth: 1 })` against the 5-commit fixture must leave a valid
 * `.git/shallow` file holding the HEAD commit oid, and `walkCommits` from
 * HEAD must terminate at that boundary with exactly one commit yielded.
 *
 * The fixture under test/fixtures/clone-source/source.git is built once by
 * scripts/regenerate-clone-fixtures.sh and committed.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend`.
 *
 * @proves
 *   surface: fetch.shallow
 *   bucket:  real-http
 *   unique:  shallow clone writes .git/shallow and bounds walkCommits to depth 1
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkCommits } from '../../../src/application/primitives/index.js';
import type { ObjectId } from '../../../src/domain/objects/object-id.js';
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

describe.skipIf(SKIP_REASON !== false)(
  'clone depth:1 — end-to-end shallow against git-http-backend',
  () => {
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

    it('Given a local git-http-backend, When clone with depth:1 runs, Then.git/shallow exists and walkCommits stops at the boundary', async () => {
      // Arrange
      workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-shallow-it-'));
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

      // Act
      const result = await repo.clone({
        url,
        depth: 1,
        allowInsecure: true,
        allowPrivateNetworks: true,
        resolver: async () => ['127.0.0.1'],
      });

      // Assert — clone result
      expect(result.head).toBe('refs/heads/main');

      // Assert —.git/shallow contains exactly the HEAD oid
      const expectedHead = (await readFile(HEAD_OID_FILE, 'utf8')).trim() as ObjectId;
      const shallowPath = path.join(repo.ctx.layout.gitDir, 'shallow');
      const shallowContent = (await readFile(shallowPath, 'utf8')).trim();
      expect(shallowContent.split('\n')).toEqual([expectedHead]);

      // Assert — walking from HEAD yields exactly one commit; no OBJECT_NOT_FOUND
      const shallowSet = new Set<ObjectId>([expectedHead]);
      const walker = walkCommits(repo.ctx, {
        from: [expectedHead],
        shallow: shallowSet,
      });
      const seen: ObjectId[] = [];
      for await (const commit of walker) {
        seen.push(commit.id);
      }
      expect(seen).toEqual([expectedHead]);

      await repo.dispose();
    }, 30_000);
  },
);

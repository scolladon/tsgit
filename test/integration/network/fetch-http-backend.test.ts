/**
 * End-to-end `fetch` against a local `git-http-backend` over Node's built-in
 * http server. Sibling of `clone-http-backend.test.ts`: clones first, then
 * runs `fetch` against the same fixture and asserts that the
 * `refs/remotes/origin/main` remote-tracking ref is at the fixture's HEAD oid
 * and that the full commit history is reachable from it.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend`.
 *
 * @proves
 *   surface: fetch
 *   bucket:  real-http
 *   unique:  fetch updates refs/remotes/origin/* from canonical git-http-backend
 */
import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __resetConfigCacheForTests } from '../../../src/application/primitives/config-read.js';
import { walkCommits } from '../../../src/application/primitives/index.js';
import type { ObjectId, RefName } from '../../../src/domain/objects/index.js';
import { openRepository, type Repository } from '../../../src/index.node.js';
import { git, gitAsync, runGit, runGitEnv, tryRunGit } from '../interop-helpers.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');
const HEAD_HISTORY_FILE = path.join(FIXTURE_DIR, 'HEAD-history.txt');

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

    await repo.clone({ url });

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

describe.skipIf(SKIP_REASON !== false)(
  'fetch — default remote resolution against git-http-backend',
  () => {
    let server: http.Server;
    let port: number;
    let projectRoot: string;
    const workDirs: string[] = [];

    const bareUrl = (name: string): string => `http://127.0.0.1:${port}/${name}.git`;

    const seedBare = async (name: string): Promise<void> => {
      runGit(['init', '-q', '--bare', path.join(projectRoot, `${name}.git`)]);
      const seedDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fetch-remote-seed-${name}-`));
      workDirs.push(seedDir);
      git(seedDir, 'clone', '-q', path.join(projectRoot, `${name}.git`), '.');
      git(seedDir, 'config', 'user.name', 'Ada');
      git(seedDir, 'config', 'user.email', 'ada@example.com');
      await writeFile(path.join(seedDir, `${name}.txt`), `${name}\n`);
      git(seedDir, 'add', `${name}.txt`);
      git(seedDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', name);
      git(seedDir, 'push', '-q', 'origin', 'HEAD:main');
    };

    const initGitRepo = async (): Promise<string> => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fetch-remote-real-'));
      workDirs.push(dir);
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.name', 'Ada');
      git(dir, 'config', 'user.email', 'ada@example.com');
      return dir;
    };

    const initTsgitRepo = async (): Promise<{ repo: Repository; dir: string }> => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fetch-remote-ts-'));
      workDirs.push(dir);
      const repo = await openRepository({
        cwd: dir,
        allowInsecureHttp: true,
        config: {
          allowInsecure: true,
          allowPrivateNetworks: true,
          dnsResolver: async () => ['127.0.0.1'],
        },
      });
      await repo.init();
      return { repo, dir };
    };

    const appendConfig = async (repo: Repository, block: string): Promise<void> => {
      const configPath = path.join(repo.ctx.layout.gitDir, 'config');
      const existing = await readFile(configPath, 'utf8');
      await writeFile(configPath, `${existing}\n${block}\n`);
      __resetConfigCacheForTests();
    };

    // Which of `candidates` got a `refs/remotes/<name>/main` tracking ref
    // after a real-git fetch — proves which remote real git itself resolved to.
    const resolvedRemoteReal = (dir: string, candidates: readonly string[]): string => {
      const matches = candidates.filter(
        (name) => tryRunGit(['-C', dir, 'rev-parse', `refs/remotes/${name}/main`]).ok,
      );
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one remote-tracking ref among [${candidates.join(', ')}], found [${matches.join(', ')}]`,
        );
      }
      return matches[0] as string;
    };

    beforeAll(async () => {
      projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fetch-remote-fixture-'));
      for (const name of ['origin', 'upstream', 'solo']) {
        await seedBare(name);
      }
      server = http.createServer((req, res) => {
        handleRequest(GIT_HTTP_BACKEND as string, projectRoot, req, res);
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
      await rm(projectRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it('Given branch.main.remote set to a non-default remote, When fetch runs with no explicit remote, Then it resolves the same remote real git does', async () => {
      // Arrange — real-git twin: two remotes, branch tracking points at "upstream".
      const gitDir = await initGitRepo();
      git(gitDir, 'remote', 'add', 'origin', bareUrl('origin'));
      git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream'));
      git(gitDir, 'config', 'branch.main.remote', 'upstream');
      await gitAsync(gitDir, 'fetch', '-q');
      const gitChose = resolvedRemoteReal(gitDir, ['origin', 'upstream']);
      const gitOid = git(gitDir, 'rev-parse', `refs/remotes/${gitChose}/main`).trim();

      // Arrange — tsgit twin: identical remote + branch tracking config.
      const { repo } = await initTsgitRepo();
      await appendConfig(
        repo,
        [
          '[remote "origin"]',
          `  url = ${bareUrl('origin')}`,
          '  fetch = +refs/heads/*:refs/remotes/origin/*',
          '[remote "upstream"]',
          `  url = ${bareUrl('upstream')}`,
          '  fetch = +refs/heads/*:refs/remotes/upstream/*',
          '[branch "main"]',
          '  remote = upstream',
        ].join('\n'),
      );

      // Act
      const sut = await repo.fetch();

      // Assert — tsgit resolves the exact remote real git resolved to.
      expect(sut.remote).toBe(gitChose);
      const mainUpdate = sut.updatedRefs.find(
        (r) => r.name === (`refs/remotes/${sut.remote}/main` as RefName),
      );
      expect(mainUpdate?.newId).toBe(gitOid as ObjectId);

      await repo.dispose();
    }, 30_000);

    it('Given no branch tracking and two remotes configured, When fetch runs with no explicit remote, Then it resolves the same remote real git does', async () => {
      // Arrange — real-git twin: two remotes, no branch tracking configured.
      const gitDir = await initGitRepo();
      git(gitDir, 'remote', 'add', 'origin', bareUrl('origin'));
      git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream'));
      await gitAsync(gitDir, 'fetch', '-q');
      const gitChose = resolvedRemoteReal(gitDir, ['origin', 'upstream']);
      const gitOid = git(gitDir, 'rev-parse', `refs/remotes/${gitChose}/main`).trim();

      // Arrange — tsgit twin: identical remotes, no branch section.
      const { repo } = await initTsgitRepo();
      await appendConfig(
        repo,
        [
          '[remote "origin"]',
          `  url = ${bareUrl('origin')}`,
          '  fetch = +refs/heads/*:refs/remotes/origin/*',
          '[remote "upstream"]',
          `  url = ${bareUrl('upstream')}`,
          '  fetch = +refs/heads/*:refs/remotes/upstream/*',
        ].join('\n'),
      );

      // Act
      const sut = await repo.fetch();

      // Assert
      expect(sut.remote).toBe(gitChose);
      const mainUpdate = sut.updatedRefs.find(
        (r) => r.name === (`refs/remotes/${sut.remote}/main` as RefName),
      );
      expect(mainUpdate?.newId).toBe(gitOid as ObjectId);

      await repo.dispose();
    }, 30_000);

    it('Given branch.main.remote set and an explicit remote argument, When fetch runs, Then the explicit argument overrides tracking the same way it does for real git', async () => {
      // Arrange — real-git twin: branch tracking points at "upstream", but the
      // fetch call explicitly names "origin".
      const gitDir = await initGitRepo();
      git(gitDir, 'remote', 'add', 'origin', bareUrl('origin'));
      git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream'));
      git(gitDir, 'config', 'branch.main.remote', 'upstream');
      await gitAsync(gitDir, 'fetch', '-q', 'origin');
      const gitOid = git(gitDir, 'rev-parse', 'refs/remotes/origin/main').trim();

      // Arrange — tsgit twin: identical config, same explicit override.
      const { repo } = await initTsgitRepo();
      await appendConfig(
        repo,
        [
          '[remote "origin"]',
          `  url = ${bareUrl('origin')}`,
          '  fetch = +refs/heads/*:refs/remotes/origin/*',
          '[remote "upstream"]',
          `  url = ${bareUrl('upstream')}`,
          '  fetch = +refs/heads/*:refs/remotes/upstream/*',
          '[branch "main"]',
          '  remote = upstream',
        ].join('\n'),
      );

      // Act
      const sut = await repo.fetch({ remote: 'origin' });

      // Assert
      expect(sut.remote).toBe('origin');
      const mainUpdate = sut.updatedRefs.find(
        (r) => r.name === ('refs/remotes/origin/main' as RefName),
      );
      expect(mainUpdate?.newId).toBe(gitOid as ObjectId);

      await repo.dispose();
    }, 30_000);

    it('Given a detached HEAD with branch.main.remote set and two remotes configured, When fetch runs with no explicit remote, Then the branch tracking step is skipped the same way it is for real git', async () => {
      // Arrange — real-git twin: commit once so there is something to detach
      // onto, configure tracking while still on main, then detach; the
      // config must survive but must not be consulted while detached.
      const gitDir = await initGitRepo();
      await writeFile(path.join(gitDir, 'placeholder.txt'), 'placeholder\n');
      git(gitDir, 'add', 'placeholder.txt');
      git(gitDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'placeholder');
      git(gitDir, 'remote', 'add', 'origin', bareUrl('origin'));
      git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream'));
      git(gitDir, 'config', 'branch.main.remote', 'upstream');
      git(gitDir, 'checkout', '-q', '--detach', 'HEAD');
      await gitAsync(gitDir, 'fetch', '-q');
      const gitChose = resolvedRemoteReal(gitDir, ['origin', 'upstream']);
      const gitOid = git(gitDir, 'rev-parse', `refs/remotes/${gitChose}/main`).trim();

      // Arrange — tsgit twin: same commit + detach + tracking config, using
      // real git to build the on-disk state (tsgit's repo is git-faithful,
      // so real git can operate on it directly) before tsgit's own fetch runs.
      const { repo, dir } = await initTsgitRepo();
      git(dir, 'config', 'user.name', 'Ada');
      git(dir, 'config', 'user.email', 'ada@example.com');
      await writeFile(path.join(dir, 'placeholder.txt'), 'placeholder\n');
      git(dir, 'add', 'placeholder.txt');
      git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'placeholder');
      git(dir, 'checkout', '-q', '--detach', 'HEAD');
      await appendConfig(
        repo,
        [
          '[remote "origin"]',
          `  url = ${bareUrl('origin')}`,
          '  fetch = +refs/heads/*:refs/remotes/origin/*',
          '[remote "upstream"]',
          `  url = ${bareUrl('upstream')}`,
          '  fetch = +refs/heads/*:refs/remotes/upstream/*',
          '[branch "main"]',
          '  remote = upstream',
        ].join('\n'),
      );

      // Act
      const sut = await repo.fetch();

      // Assert
      expect(sut.remote).toBe(gitChose);
      const mainUpdate = sut.updatedRefs.find(
        (r) => r.name === (`refs/remotes/${sut.remote}/main` as RefName),
      );
      expect(mainUpdate?.newId).toBe(gitOid as ObjectId);

      await repo.dispose();
    }, 30_000);

    it('Given exactly one non-origin remote configured and no branch tracking, When fetch runs with no explicit remote, Then it resolves the sole remote the same way real git does', async () => {
      // Arrange — real-git twin: only "solo" is configured.
      const gitDir = await initGitRepo();
      git(gitDir, 'remote', 'add', 'solo', bareUrl('solo'));
      await gitAsync(gitDir, 'fetch', '-q');
      const gitOid = git(gitDir, 'rev-parse', 'refs/remotes/solo/main').trim();

      // Arrange — tsgit twin: identical sole-remote config.
      const { repo } = await initTsgitRepo();
      await appendConfig(
        repo,
        [
          '[remote "solo"]',
          `  url = ${bareUrl('solo')}`,
          '  fetch = +refs/heads/*:refs/remotes/solo/*',
        ].join('\n'),
      );

      // Act
      const sut = await repo.fetch();

      // Assert
      expect(sut.remote).toBe('solo');
      const mainUpdate = sut.updatedRefs.find(
        (r) => r.name === ('refs/remotes/solo/main' as RefName),
      );
      expect(mainUpdate?.newId).toBe(gitOid as ObjectId);

      await repo.dispose();
    }, 30_000);
  },
);

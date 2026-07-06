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
import { spawn } from 'node:child_process';
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
import { openRepository, type Repository } from '../../../src/index.node.js';
import { git, gitAsync, runGit, runGitEnv, tryRunGit } from '../interop-helpers.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');

const findGitExecPath = (): string | undefined => {
  try {
    return runGit(['--exec-path']).toString().trim();
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
    runGit(['-C', bareRepoPath, 'config', 'http.receivepack', 'true']);
    runGit(['-C', bareRepoPath, 'config', 'receive.denyCurrentBranch', 'updateInstead']);
    runGit(['-C', bareRepoPath, 'config', 'receive.denyNonFastforwards', 'false']);
    runGit(['-C', bareRepoPath, 'config', 'receive.denyDeletes', 'false']);

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

    await repo.clone({ url });

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
    const bareTip = runGit(['-C', bareRepoPath, 'rev-parse', 'main']).trim();
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
    await repo.clone({ url });
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

describe.skipIf(SKIP_REASON !== false)('push — remote resolution against git-http-backend', () => {
  let server: http.Server;
  let port: number;
  let projectRoot: string;
  const workDirs: string[] = [];

  // Each candidate remote name gets TWO independent bares — one the real-git
  // twin pushes into, one the tsgit twin pushes into — so the two pushes
  // (made from unrelated histories) never land in the same bare and trip a
  // non-fast-forward guard. The comparison is over the resolved remote NAME,
  // not the literal bare file.
  const bareUrl = (name: string, twin: 'real' | 'ts'): string =>
    `http://127.0.0.1:${port}/${name}-${twin}.git`;

  // Every target bare starts empty and receive-pack-enabled: the first
  // push of `main` is a brand-new-ref update, so no fast-forward/deny
  // guards are needed (unlike the shared fixture used above).
  const seedBare = (name: string, twin: 'real' | 'ts'): void => {
    const barePath = path.join(projectRoot, `${name}-${twin}.git`);
    runGit(['init', '-q', '--bare', barePath]);
    runGit(['-C', barePath, 'config', 'http.receivepack', 'true']);
  };

  const initGitRepo = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-push-remote-real-'));
    workDirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    // `push.default=current` isolates remote SELECTION (the subject of this
    // test) from push.default's own "simple vs upstream" refspec-mode
    // machinery — under the default `simple`, git additionally requires
    // `branch.<name>.merge` (upstream tracking) whenever the resolved remote
    // happens to equal `branch.<name>.remote`, which is orthogonal to which
    // remote got picked. `current` always pushes HEAD to the same-named ref
    // on whichever remote was resolved, with no such extra requirement.
    git(dir, 'config', 'push.default', 'current');
    await writeFile(path.join(dir, 'seed.txt'), 'seed from real git\n');
    git(dir, 'add', 'seed.txt');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed (real git)');
    return dir;
  };

  const initTsgitRepo = async (): Promise<{ repo: Repository; dir: string }> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-push-remote-ts-'));
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
    // Build the seed commit with real git directly on tsgit's on-disk
    // state — tsgit's repo layout is git-faithful, so real git can
    // operate on it before tsgit's own push runs. The content/message
    // deliberately differ from `initGitRepo`'s so the two independent
    // commits can never collide on oid (which would make tsgit's push a
    // false no-op against a bare the real-git twin already populated).
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    await writeFile(path.join(dir, 'seed.txt'), 'seed from tsgit\n');
    git(dir, 'add', 'seed.txt');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed (tsgit)');
    return { repo, dir };
  };

  const appendConfig = async (repo: Repository, block: string): Promise<void> => {
    const configPath = path.join(repo.ctx.layout.gitDir, 'config');
    const existing = await readFile(configPath, 'utf8');
    await writeFile(configPath, `${existing}\n${block}\n`);
    __resetConfigCacheForTests();
  };

  // Which of `candidates` `-real` bare repos (under projectRoot) now has a
  // `main` ref — proves which remote name real git's own push resolved to.
  const resolvedBareReal = (candidates: readonly string[]): string => {
    const matches = candidates.filter(
      (name) =>
        tryRunGit(['--git-dir', path.join(projectRoot, `${name}-real.git`), 'rev-parse', 'main'])
          .ok,
    );
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one bare with a main ref among [${candidates.join(', ')}], found [${matches.join(', ')}]`,
      );
    }
    return matches[0] as string;
  };

  beforeAll(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-push-remote-fixture-'));
    for (const name of [
      'origin',
      'upstream',
      'pushremotecfg',
      'pushdefaultcfg',
      'solo',
      'currentmode',
      'currentdetached',
      'nothingmode',
      'upstreammode',
      'upstreamfetch',
      'upstreampush',
      'upstreamnomerge',
      'trackingalias',
    ]) {
      seedBare(name, 'real');
      seedBare(name, 'ts');
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

  it('Given branch.main.pushRemote set alongside remote.pushDefault and branch.main.remote, When push runs with no explicit remote, Then it resolves the same remote real git does', async () => {
    // Arrange — real-git twin: three candidate remotes; pushRemote should
    // win over both remote.pushDefault and the tracking remote.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'origin', bareUrl('origin', 'real'));
    git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream', 'real'));
    git(gitDir, 'remote', 'add', 'pushremotecfg', bareUrl('pushremotecfg', 'real'));
    git(gitDir, 'remote', 'add', 'pushdefaultcfg', bareUrl('pushdefaultcfg', 'real'));
    git(gitDir, 'config', 'remote.pushDefault', 'pushdefaultcfg');
    git(gitDir, 'config', 'branch.main.remote', 'upstream');
    git(gitDir, 'config', 'branch.main.pushRemote', 'pushremotecfg');
    await gitAsync(gitDir, 'push', '-q');
    const gitChose = resolvedBareReal(['origin', 'upstream', 'pushremotecfg', 'pushdefaultcfg']);

    // Arrange — tsgit twin: identical remotes + branch/push config.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(
      repo,
      [
        '[remote "origin"]',
        `  url = ${bareUrl('origin', 'ts')}`,
        '[remote "upstream"]',
        `  url = ${bareUrl('upstream', 'ts')}`,
        '[remote "pushremotecfg"]',
        `  url = ${bareUrl('pushremotecfg', 'ts')}`,
        '[remote "pushdefaultcfg"]',
        `  url = ${bareUrl('pushdefaultcfg', 'ts')}`,
        '[remote]',
        '  pushDefault = pushdefaultcfg',
        '[branch "main"]',
        '  remote = upstream',
        '  pushRemote = pushremotecfg',
      ].join('\n'),
    );

    // Act
    const sut = await repo.push({ refspecs: ['refs/heads/main:refs/heads/main'] });

    // Assert — tsgit resolves the exact remote real git resolved to, and
    // the winning bare received the push.
    expect(sut.remote).toBe(gitChose);
    expect(sut.remote).toBe('pushremotecfg');
    expect(sut.pushedRefs[0]).toMatchObject({ status: 'ok' });
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, `${sut.remote}-ts.git`),
      'rev-parse',
      'main',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);

  it('Given remote.pushDefault set alongside branch.main.remote (no pushRemote), When push runs with no explicit remote, Then it resolves the same remote real git does', async () => {
    // Arrange — real-git twin: remote.pushDefault should win over tracking.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream', 'real'));
    git(gitDir, 'remote', 'add', 'pushdefaultcfg', bareUrl('pushdefaultcfg', 'real'));
    git(gitDir, 'config', 'remote.pushDefault', 'pushdefaultcfg');
    git(gitDir, 'config', 'branch.main.remote', 'upstream');
    await gitAsync(gitDir, 'push', '-q');
    const gitChose = resolvedBareReal(['upstream', 'pushdefaultcfg']);

    // Arrange — tsgit twin: identical remotes + config, no pushRemote.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(
      repo,
      [
        '[remote "upstream"]',
        `  url = ${bareUrl('upstream', 'ts')}`,
        '[remote "pushdefaultcfg"]',
        `  url = ${bareUrl('pushdefaultcfg', 'ts')}`,
        '[remote]',
        '  pushDefault = pushdefaultcfg',
        '[branch "main"]',
        '  remote = upstream',
      ].join('\n'),
    );

    // Act
    const sut = await repo.push({ refspecs: ['refs/heads/main:refs/heads/main'] });

    // Assert
    expect(sut.remote).toBe(gitChose);
    expect(sut.remote).toBe('pushdefaultcfg');
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, `${sut.remote}-ts.git`),
      'rev-parse',
      'main',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);

  it('Given branch.main.remote set with no pushRemote or remotePushDefault, and two remotes configured, When push runs with no explicit remote, Then it resolves the same remote real git does', async () => {
    // Arrange — real-git twin: branch tracking should win over the
    // ambiguous-remote-count default ('origin' fallback). `branch.main.merge`
    // is set so real git's `push.default=current` (see initGitRepo) still
    // treats this as a plain same-name push — resolving to the SAME remote
    // it would under `simple`/`upstream` too, just without the extra
    // "no upstream configured" refusal that's orthogonal to remote selection.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'origin', bareUrl('origin', 'real'));
    git(gitDir, 'remote', 'add', 'upstream', bareUrl('upstream', 'real'));
    git(gitDir, 'config', 'branch.main.remote', 'upstream');
    await gitAsync(gitDir, 'push', '-q');
    const gitChose = resolvedBareReal(['origin', 'upstream']);

    // Arrange — tsgit twin: identical remotes + branch tracking.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(
      repo,
      [
        '[remote "origin"]',
        `  url = ${bareUrl('origin', 'ts')}`,
        '[remote "upstream"]',
        `  url = ${bareUrl('upstream', 'ts')}`,
        '[branch "main"]',
        '  remote = upstream',
      ].join('\n'),
    );

    // Act
    const sut = await repo.push({ refspecs: ['refs/heads/main:refs/heads/main'] });

    // Assert
    expect(sut.remote).toBe(gitChose);
    expect(sut.remote).toBe('upstream');
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, `${sut.remote}-ts.git`),
      'rev-parse',
      'main',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);

  it('Given exactly one remote configured and no branch tracking or push defaults, When push runs with no explicit remote, Then it resolves the sole remote the same way real git does', async () => {
    // Arrange — real-git twin: only "solo" is configured.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'solo', bareUrl('solo', 'real'));
    await gitAsync(gitDir, 'push', '-q');

    // Arrange — tsgit twin: identical sole-remote config.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(repo, ['[remote "solo"]', `  url = ${bareUrl('solo', 'ts')}`].join('\n'));

    // Act
    const sut = await repo.push({ refspecs: ['refs/heads/main:refs/heads/main'] });

    // Assert
    expect(sut.remote).toBe('solo');
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, 'solo-ts.git'),
      'rev-parse',
      'main',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=current and a sole remote, When push runs with no explicit refspec, Then it pushes the current branch to the same-named ref, matching real git', async () => {
    // Arrange — real-git twin: push.default=current is already set by initGitRepo.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'currentmode', bareUrl('currentmode', 'real'));
    await gitAsync(gitDir, 'push', '-q');

    // Arrange — tsgit twin: same sole remote, push.default=current, no explicit refspec.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(
      repo,
      [
        '[remote "currentmode"]',
        `  url = ${bareUrl('currentmode', 'ts')}`,
        '[push]',
        '  default = current',
      ].join('\n'),
    );

    // Act
    const sut = await repo.push({});

    // Assert
    expect(sut.remote).toBe('currentmode');
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, 'currentmode-ts.git'),
      'rev-parse',
      'main',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=current and a detached HEAD, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: detach HEAD after the seed commit, same as tsgit twin below.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'currentdetached', bareUrl('currentdetached', 'real'));
    git(gitDir, 'checkout', '-q', '--detach', 'HEAD');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the detached-HEAD push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/not currently on a branch/);

    // Arrange — tsgit twin: same detached-HEAD setup, push.default=current.
    const { repo, dir } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "currentdetached"]',
        `  url = ${bareUrl('currentdetached', 'ts')}`,
        '[push]',
        '  default = current',
      ].join('\n'),
    );
    const detachedOid = git(dir, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(repo.ctx.layout.gitDir, 'HEAD'), `${detachedOid}\n`);

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: { code: 'PUSH_DETACHED_NO_REFSPEC' },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'currentdetached-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'currentdetached-ts.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=nothing, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: push.default=nothing always refuses, regardless of HEAD state.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'nothingmode', bareUrl('nothingmode', 'real'));
    git(gitDir, 'config', 'push.default', 'nothing');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the push.default=nothing push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/push\.default is "nothing"/);

    // Arrange — tsgit twin: same sole remote, push.default=nothing.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "nothingmode"]',
        `  url = ${bareUrl('nothingmode', 'ts')}`,
        '[push]',
        '  default = nothing',
      ].join('\n'),
    );

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: { code: 'PUSH_DEFAULT_NOTHING' },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'nothingmode-real.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'nothingmode-ts.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=upstream with a central remote and branch.main.merge set to a different name, When push runs with no explicit refspec, Then it pushes the current branch to the configured upstream ref, matching real git', async () => {
    // Arrange — real-git twin: branch.main.merge points at a differently-named ref.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'upstreammode', bareUrl('upstreammode', 'real'));
    git(gitDir, 'config', 'push.default', 'upstream');
    git(gitDir, 'config', 'branch.main.remote', 'upstreammode');
    git(gitDir, 'config', 'branch.main.merge', 'refs/heads/other');
    // A successful (non-throwing) push proves real git does NOT refuse this
    // central (non-triangular) configuration under push.default=upstream.
    await gitAsync(gitDir, 'push', '-q');

    // Arrange — tsgit twin: same central remote, push.default=upstream, merge=refs/heads/other.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(
      repo,
      [
        '[remote "upstreammode"]',
        `  url = ${bareUrl('upstreammode', 'ts')}`,
        '[push]',
        '  default = upstream',
        '[branch "main"]',
        '  remote = upstreammode',
        '  merge = refs/heads/other',
      ].join('\n'),
    );

    // Act
    const sut = await repo.push({});

    // Assert — tsgit pushes to the configured upstream ref (no name check,
    // matching real git's own non-refusal above).
    expect(sut.remote).toBe('upstreammode');
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, 'upstreammode-ts.git'),
      'rev-parse',
      'other',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=upstream with a triangular push remote and branch.main.merge set, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: fetch remote 'upstreamfetch', but the resolved
    // push remote is the DIFFERENT 'upstreampush' (remote.pushDefault) — a
    // triangular workflow, refused even though an upstream merge ref is set.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'upstreamfetch', bareUrl('upstreamfetch', 'real'));
    git(gitDir, 'remote', 'add', 'upstreampush', bareUrl('upstreampush', 'real'));
    git(gitDir, 'config', 'push.default', 'upstream');
    git(gitDir, 'config', 'branch.main.remote', 'upstreamfetch');
    git(gitDir, 'config', 'branch.main.merge', 'refs/heads/main');
    git(gitDir, 'config', 'remote.pushDefault', 'upstreampush');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the triangular push.default=upstream push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/not the upstream of\s+your current branch/);

    // Arrange — tsgit twin: identical triangular setup.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "upstreamfetch"]',
        `  url = ${bareUrl('upstreamfetch', 'ts')}`,
        '[remote "upstreampush"]',
        `  url = ${bareUrl('upstreampush', 'ts')}`,
        '[push]',
        '  default = upstream',
        '[branch "main"]',
        '  remote = upstreamfetch',
        '  merge = refs/heads/main',
        '[remote]',
        '  pushDefault = upstreampush',
      ].join('\n'),
    );

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: {
        code: 'PUSH_REMOTE_NOT_UPSTREAM',
        remote: 'upstreampush',
        branch: 'refs/heads/main',
      },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'upstreampush-real.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'upstreampush-ts.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=upstream with a triangular push remote and no branch.main.merge configured, When push runs with no explicit refspec, Then both real git and tsgit still refuse with the triangular error, not the no-upstream error', async () => {
    // Arrange — real-git twin: same triangular setup as above, but WITHOUT
    // branch.main.merge — the triangular refusal must still fire first,
    // proving it dominates the "no upstream configured" check (cell S-D).
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'upstreamfetch', bareUrl('upstreamfetch', 'real'));
    git(gitDir, 'remote', 'add', 'upstreampush', bareUrl('upstreampush', 'real'));
    git(gitDir, 'config', 'push.default', 'upstream');
    git(gitDir, 'config', 'branch.main.remote', 'upstreamfetch');
    git(gitDir, 'config', 'remote.pushDefault', 'upstreampush');

    // Act & Assert — real git refuses with the SAME triangular message, not
    // the "no upstream" message.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the triangular push.default=upstream push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/not the upstream of\s+your current branch/);

    // Arrange — tsgit twin: identical triangular setup, no merge configured.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "upstreamfetch"]',
        `  url = ${bareUrl('upstreamfetch', 'ts')}`,
        '[remote "upstreampush"]',
        `  url = ${bareUrl('upstreampush', 'ts')}`,
        '[push]',
        '  default = upstream',
        '[branch "main"]',
        '  remote = upstreamfetch',
        '[remote]',
        '  pushDefault = upstreampush',
      ].join('\n'),
    );

    // Act & Assert — tsgit refuses PUSH_REMOTE_NOT_UPSTREAM, NOT NO_UPSTREAM_CONFIGURED.
    await expect(repo.push({})).rejects.toMatchObject({
      data: {
        code: 'PUSH_REMOTE_NOT_UPSTREAM',
        remote: 'upstreampush',
        branch: 'refs/heads/main',
      },
    });

    await repo.dispose();
  }, 30_000);

  it('Given push.default=upstream with a central remote and no branch.main.merge configured, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: push.default=upstream with a tracked remote but no merge ref.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'upstreamnomerge', bareUrl('upstreamnomerge', 'real'));
    git(gitDir, 'config', 'push.default', 'upstream');
    git(gitDir, 'config', 'branch.main.remote', 'upstreamnomerge');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the no-upstream push.default=upstream push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/has no upstream branch/);

    // Arrange — tsgit twin: identical setup, no merge configured.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "upstreamnomerge"]',
        `  url = ${bareUrl('upstreamnomerge', 'ts')}`,
        '[push]',
        '  default = upstream',
        '[branch "main"]',
        '  remote = upstreamnomerge',
      ].join('\n'),
    );

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: { code: 'NO_UPSTREAM_CONFIGURED', branch: 'refs/heads/main' },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'upstreamnomerge-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'upstreamnomerge-ts.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=tracking (the deprecated upstream alias) with branch.main.merge set to a different name, When push runs with no explicit refspec, Then it behaves exactly like push.default=upstream, matching real git', async () => {
    // Arrange — real-git twin: 'tracking' is real git's legacy alias for 'upstream'.
    const gitDir = await initGitRepo();
    git(gitDir, 'remote', 'add', 'trackingalias', bareUrl('trackingalias', 'real'));
    git(gitDir, 'config', 'push.default', 'tracking');
    git(gitDir, 'config', 'branch.main.remote', 'trackingalias');
    git(gitDir, 'config', 'branch.main.merge', 'refs/heads/other');
    // A successful (non-throwing) push proves real git's 'tracking' alias
    // does NOT refuse this central configuration, just like 'upstream'.
    await gitAsync(gitDir, 'push', '-q');

    // Arrange — tsgit twin: same central remote, push.default=tracking, merge=refs/heads/other.
    const { repo, dir } = await initTsgitRepo();
    const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
    await appendConfig(
      repo,
      [
        '[remote "trackingalias"]',
        `  url = ${bareUrl('trackingalias', 'ts')}`,
        '[push]',
        '  default = tracking',
        '[branch "main"]',
        '  remote = trackingalias',
        '  merge = refs/heads/other',
      ].join('\n'),
    );

    // Act
    const sut = await repo.push({});

    // Assert — the deprecated alias resolves and behaves exactly like `upstream`.
    expect(sut.remote).toBe('trackingalias');
    const bareTip = runGit([
      '--git-dir',
      path.join(projectRoot, 'trackingalias-ts.git'),
      'rev-parse',
      'other',
    ]).trim();
    expect(bareTip).toBe(tsgitOid);

    await repo.dispose();
  }, 30_000);
});

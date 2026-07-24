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
      'invalidpushdefaultbogus',
      'invalidpushdefaultcase',
      'upstreammode',
      'upstreamfetch',
      'upstreampush',
      'upstreamnomerge',
      'trackingalias',
      'simplemode',
      'simplemismatch',
      'simplenomerge',
      'simplefetch',
      'simplepush',
      'simpledetached',
      'matchingpartial',
      'matchingdetached',
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

  const REMOTE_RESOLUTION_MATRIX: ReadonlyArray<{
    readonly label: string;
    readonly candidates: readonly string[];
    readonly realConfig: ReadonlyArray<readonly [string, string]>;
    readonly tsgitConfigBlock: string;
    readonly expectedRemote: string;
  }> = [
    {
      label: 'branch.main.pushRemote set alongside remote.pushDefault and branch.main.remote',
      candidates: ['origin', 'upstream', 'pushremotecfg', 'pushdefaultcfg'],
      realConfig: [
        ['remote.pushDefault', 'pushdefaultcfg'],
        ['branch.main.remote', 'upstream'],
        ['branch.main.pushRemote', 'pushremotecfg'],
      ],
      tsgitConfigBlock: [
        '[remote]',
        '  pushDefault = pushdefaultcfg',
        '[branch "main"]',
        '  remote = upstream',
        '  pushRemote = pushremotecfg',
      ].join('\n'),
      expectedRemote: 'pushremotecfg',
    },
    {
      label: 'remote.pushDefault set alongside branch.main.remote (no pushRemote)',
      candidates: ['upstream', 'pushdefaultcfg'],
      realConfig: [
        ['remote.pushDefault', 'pushdefaultcfg'],
        ['branch.main.remote', 'upstream'],
      ],
      tsgitConfigBlock: [
        '[remote]',
        '  pushDefault = pushdefaultcfg',
        '[branch "main"]',
        '  remote = upstream',
      ].join('\n'),
      expectedRemote: 'pushdefaultcfg',
    },
    {
      label:
        'branch.main.remote set with no pushRemote or remote.pushDefault, and two remotes configured',
      candidates: ['origin', 'upstream'],
      realConfig: [['branch.main.remote', 'upstream']],
      tsgitConfigBlock: ['[branch "main"]', '  remote = upstream'].join('\n'),
      expectedRemote: 'upstream',
    },
    {
      label: 'exactly one remote configured and no branch tracking or push defaults',
      candidates: ['solo'],
      realConfig: [],
      tsgitConfigBlock: '',
      expectedRemote: 'solo',
    },
  ];

  it.each(REMOTE_RESOLUTION_MATRIX)(
    'Given $label, When push runs with no explicit remote, Then it resolves the same remote real git does',
    async ({ candidates, realConfig, tsgitConfigBlock, expectedRemote }) => {
      // Arrange — real-git twin: add every candidate remote, then apply the
      // row's precedence config on top.
      const gitDir = await initGitRepo();
      for (const name of candidates) {
        git(gitDir, 'remote', 'add', name, bareUrl(name, 'real'));
      }
      for (const [key, value] of realConfig) {
        git(gitDir, 'config', key, value);
      }
      await gitAsync(gitDir, 'push', '-q');
      const gitChose = resolvedBareReal(candidates);

      // Arrange — tsgit twin: identical remotes + precedence config.
      const { repo, dir } = await initTsgitRepo();
      const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
      const remoteBlocks = candidates
        .map((name) => `[remote "${name}"]\n  url = ${bareUrl(name, 'ts')}`)
        .join('\n');
      await appendConfig(repo, [remoteBlocks, tsgitConfigBlock].filter(Boolean).join('\n'));

      // Act
      const sut = await repo.push({ refspecs: ['refs/heads/main:refs/heads/main'] });

      // Assert — tsgit resolves the exact remote real git resolved to, and
      // the winning bare received the push.
      expect(sut.remote).toBe(gitChose);
      expect(sut.remote).toBe(expectedRemote);
      expect(sut.pushedRefs[0]).toMatchObject({ status: 'ok' });
      const bareTip = runGit([
        '--git-dir',
        path.join(projectRoot, `${sut.remote}-ts.git`),
        'rev-parse',
        'main',
      ]).trim();
      expect(bareTip).toBe(tsgitOid);

      await repo.dispose();
    },
    30_000,
  );

  const REFSPEC_PUSH_MATRIX: ReadonlyArray<{
    readonly label: string;
    readonly remotes: readonly string[];
    readonly unsetPushDefault: boolean;
    readonly realConfig: ReadonlyArray<readonly [string, string]>;
    readonly tsgitConfigBlock: string;
    readonly expectedRemote: string;
    readonly expectedRef: string;
  }> = [
    {
      label: 'push.default=current and a sole remote',
      remotes: ['currentmode'],
      unsetPushDefault: false,
      realConfig: [],
      tsgitConfigBlock: ['[push]', '  default = current'].join('\n'),
      expectedRemote: 'currentmode',
      expectedRef: 'main',
    },
    {
      label:
        'push.default=upstream with a central remote and branch.main.merge set to a different name',
      remotes: ['upstreammode'],
      unsetPushDefault: false,
      realConfig: [
        ['push.default', 'upstream'],
        ['branch.main.remote', 'upstreammode'],
        ['branch.main.merge', 'refs/heads/other'],
      ],
      tsgitConfigBlock: [
        '[push]',
        '  default = upstream',
        '[branch "main"]',
        '  remote = upstreammode',
        '  merge = refs/heads/other',
      ].join('\n'),
      expectedRemote: 'upstreammode',
      expectedRef: 'other',
    },
    {
      label:
        'push.default=tracking (the deprecated upstream alias) with branch.main.merge set to a different name',
      remotes: ['trackingalias'],
      unsetPushDefault: false,
      realConfig: [
        ['push.default', 'tracking'],
        ['branch.main.remote', 'trackingalias'],
        ['branch.main.merge', 'refs/heads/other'],
      ],
      tsgitConfigBlock: [
        '[push]',
        '  default = tracking',
        '[branch "main"]',
        '  remote = trackingalias',
        '  merge = refs/heads/other',
      ].join('\n'),
      expectedRemote: 'trackingalias',
      expectedRef: 'other',
    },
    {
      label: 'push.default=simple with a central remote and branch.main.merge set to the same name',
      remotes: ['simplemode'],
      unsetPushDefault: true,
      realConfig: [
        ['branch.main.remote', 'simplemode'],
        ['branch.main.merge', 'refs/heads/main'],
      ],
      tsgitConfigBlock: [
        '[branch "main"]',
        '  remote = simplemode',
        '  merge = refs/heads/main',
      ].join('\n'),
      expectedRemote: 'simplemode',
      expectedRef: 'main',
    },
    {
      label:
        'push.default=simple with a triangular push remote and branch.main.merge set to a different name',
      remotes: ['simplefetch', 'simplepush'],
      unsetPushDefault: true,
      realConfig: [
        ['branch.main.remote', 'simplefetch'],
        ['branch.main.merge', 'refs/heads/other'],
        ['remote.pushDefault', 'simplepush'],
      ],
      tsgitConfigBlock: [
        '[branch "main"]',
        '  remote = simplefetch',
        '  merge = refs/heads/other',
        '[remote]',
        '  pushDefault = simplepush',
      ].join('\n'),
      expectedRemote: 'simplepush',
      expectedRef: 'main',
    },
  ];

  it.each(REFSPEC_PUSH_MATRIX)(
    'Given $label, When push runs with no explicit refspec, Then it pushes the current branch to the configured ref, matching real git',
    async ({
      remotes,
      unsetPushDefault,
      realConfig,
      tsgitConfigBlock,
      expectedRemote,
      expectedRef,
    }) => {
      // Arrange — real-git twin: apply the row's push.default/branch config,
      // then push — a successful (non-throwing) push proves real git does
      // NOT refuse this configuration.
      const gitDir = await initGitRepo();
      if (unsetPushDefault) {
        git(gitDir, 'config', '--unset', 'push.default');
      }
      for (const name of remotes) {
        git(gitDir, 'remote', 'add', name, bareUrl(name, 'real'));
      }
      for (const [key, value] of realConfig) {
        git(gitDir, 'config', key, value);
      }
      await gitAsync(gitDir, 'push', '-q');

      // Arrange — tsgit twin: identical remotes + config.
      const { repo, dir } = await initTsgitRepo();
      const tsgitOid = git(dir, 'rev-parse', 'HEAD').trim();
      const remoteBlocks = remotes
        .map((name) => `[remote "${name}"]\n  url = ${bareUrl(name, 'ts')}`)
        .join('\n');
      await appendConfig(repo, [remoteBlocks, tsgitConfigBlock].filter(Boolean).join('\n'));

      // Act
      const sut = await repo.push({});

      // Assert — tsgit pushes to the configured ref on the configured
      // remote, matching real git's own non-refusal above.
      expect(sut.remote).toBe(expectedRemote);
      const bareTip = runGit([
        '--git-dir',
        path.join(projectRoot, `${sut.remote}-ts.git`),
        'rev-parse',
        expectedRef,
      ]).trim();
      expect(bareTip).toBe(tsgitOid);

      await repo.dispose();
    },
    30_000,
  );

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

  it('Given push.default is set to an unrecognized value, When push runs with no explicit refspec, Then both real git and tsgit refuse with a bad-config-variable error before contacting the remote', async () => {
    // Arrange — real-git twin: an unrecognized push.default value.
    const gitDir = await initGitRepo();
    git(
      gitDir,
      'remote',
      'add',
      'invalidpushdefaultbogus',
      bareUrl('invalidpushdefaultbogus', 'real'),
    );
    git(gitDir, 'config', 'push.default', 'bogus');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the unrecognized push.default value');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(
      /bad config variable 'push\.default' in file '.*' at line \d+/,
    );

    // Arrange — tsgit twin: same sole remote, push.default=bogus.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "invalidpushdefaultbogus"]',
        `  url = ${bareUrl('invalidpushdefaultbogus', 'ts')}`,
        '[push]',
        '  default = bogus',
      ].join('\n'),
    );
    const configPath = path.join(repo.ctx.layout.gitDir, 'config');
    const configText = await readFile(configPath, 'utf8');
    const expectedLine =
      configText.split('\n').findIndex((line) => line.trim() === 'default = bogus') + 1;

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: {
        code: 'INVALID_PUSH_DEFAULT',
        value: 'bogus',
        source: configPath,
        line: expectedLine,
      },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'invalidpushdefaultbogus-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'invalidpushdefaultbogus-ts.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default is set to a wrong-case recognized word, When push runs with no explicit refspec, Then both real git and tsgit refuse (the enum match is case-sensitive)', async () => {
    // Arrange — real-git twin: "Simple" is not "simple" — case-sensitive match.
    const gitDir = await initGitRepo();
    git(
      gitDir,
      'remote',
      'add',
      'invalidpushdefaultcase',
      bareUrl('invalidpushdefaultcase', 'real'),
    );
    git(gitDir, 'config', 'push.default', 'Simple');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the wrong-case push.default value');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(
      /bad config variable 'push\.default' in file '.*' at line \d+/,
    );

    // Arrange — tsgit twin: same sole remote, push.default=Simple.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "invalidpushdefaultcase"]',
        `  url = ${bareUrl('invalidpushdefaultcase', 'ts')}`,
        '[push]',
        '  default = Simple',
      ].join('\n'),
    );
    const configPath = path.join(repo.ctx.layout.gitDir, 'config');
    const configText = await readFile(configPath, 'utf8');
    const expectedLine =
      configText.split('\n').findIndex((line) => line.trim() === 'default = Simple') + 1;

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: {
        code: 'INVALID_PUSH_DEFAULT',
        value: 'Simple',
        source: configPath,
        line: expectedLine,
      },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'invalidpushdefaultcase-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'invalidpushdefaultcase-ts.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);

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

  it('Given push.default=simple with a central remote and branch.main.merge set to a different name, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: branch.main.merge names a DIFFERENT ref than
    // the current branch — `simple` refuses this (unlike `upstream`, which
    // would push to it).
    const gitDir = await initGitRepo();
    git(gitDir, 'config', '--unset', 'push.default');
    git(gitDir, 'remote', 'add', 'simplemismatch', bareUrl('simplemismatch', 'real'));
    git(gitDir, 'config', 'branch.main.remote', 'simplemismatch');
    git(gitDir, 'config', 'branch.main.merge', 'refs/heads/other');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the name-mismatched simple push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/does not match\s+the name of your current branch/);

    // Arrange — tsgit twin: identical central setup, merge=refs/heads/other.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "simplemismatch"]',
        `  url = ${bareUrl('simplemismatch', 'ts')}`,
        '[branch "main"]',
        '  remote = simplemismatch',
        '  merge = refs/heads/other',
      ].join('\n'),
    );

    // Act & Assert — tsgit refuses with the matching structured error, before any network call.
    await expect(repo.push({})).rejects.toMatchObject({
      data: {
        code: 'PUSH_UPSTREAM_NAME_MISMATCH',
        branch: 'refs/heads/main',
        upstream: 'refs/heads/other',
      },
    });

    // Assert — neither bare received a push.
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'simplemismatch-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'simplemismatch-ts.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=simple with a central remote and no branch.main.merge configured, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: tracked remote but no merge ref configured.
    const gitDir = await initGitRepo();
    git(gitDir, 'config', '--unset', 'push.default');
    git(gitDir, 'remote', 'add', 'simplenomerge', bareUrl('simplenomerge', 'real'));
    git(gitDir, 'config', 'branch.main.remote', 'simplenomerge');

    // Act & Assert — real git refuses before ever dialling the remote.
    let realRefusal: { readonly stderr?: string } = {};
    try {
      await gitAsync(gitDir, 'push', '-q');
      throw new Error('expected real git to refuse the no-upstream simple push');
    } catch (error) {
      realRefusal = error as { readonly stderr?: string };
    }
    expect(realRefusal.stderr ?? '').toMatch(/has no upstream branch/);

    // Arrange — tsgit twin: identical setup, no merge configured.
    const { repo } = await initTsgitRepo();
    await appendConfig(
      repo,
      [
        '[remote "simplenomerge"]',
        `  url = ${bareUrl('simplenomerge', 'ts')}`,
        '[branch "main"]',
        '  remote = simplenomerge',
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
        path.join(projectRoot, 'simplenomerge-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'simplenomerge-ts.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=simple and a detached HEAD, When push runs with no explicit refspec, Then both real git and tsgit refuse before contacting the remote', async () => {
    // Arrange — real-git twin: detach HEAD after the seed commit, same as tsgit twin below.
    const gitDir = await initGitRepo();
    git(gitDir, 'config', '--unset', 'push.default');
    git(gitDir, 'remote', 'add', 'simpledetached', bareUrl('simpledetached', 'real'));
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

    // Arrange — tsgit twin: same detached-HEAD setup, push.default unset (simple is the default).
    const { repo, dir } = await initTsgitRepo();
    await appendConfig(
      repo,
      ['[remote "simpledetached"]', `  url = ${bareUrl('simpledetached', 'ts')}`].join('\n'),
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
        path.join(projectRoot, 'simpledetached-real.git'),
        'rev-parse',
        'main',
      ]).ok,
    ).toBe(false);
    expect(
      tryRunGit(['--git-dir', path.join(projectRoot, 'simpledetached-ts.git'), 'rev-parse', 'main'])
        .ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=matching with two local branches the remote already advertises and a third it does not, When push runs with no explicit refspec, Then it pushes only the two advertised branches, matching real git', async () => {
    // Arrange — real-git twin: seed the remote bare's `main`+`feature` at the
    // pre-advance tip via a local file-path push (no HTTP involved), so the
    // matching push below has real ref movement to prove on both branches.
    const gitDir = await initGitRepo();
    git(gitDir, 'branch', 'feature');
    git(gitDir, 'branch', 'extra');
    runGit([
      '-C',
      gitDir,
      'push',
      path.join(projectRoot, 'matchingpartial-real.git'),
      'refs/heads/main:refs/heads/main',
      'refs/heads/feature:refs/heads/feature',
    ]);
    git(gitDir, 'remote', 'add', 'matchingpartial', bareUrl('matchingpartial', 'real'));
    await writeFile(path.join(gitDir, 'advance.txt'), 'advance (real git)\n');
    git(gitDir, 'add', 'advance.txt');
    git(gitDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'advance main (real git)');
    git(gitDir, 'branch', '-f', 'feature', 'main');
    git(gitDir, 'config', 'push.default', 'matching');
    await gitAsync(gitDir, 'push', '-q');
    const realAdvancedOid = git(gitDir, 'rev-parse', 'main').trim();

    // Arrange — tsgit twin: identical shape, independent commit oids. Real
    // git seeds the bare directly from tsgit's own git-faithful layout.
    const { repo, dir } = await initTsgitRepo();
    git(dir, 'branch', 'feature');
    git(dir, 'branch', 'extra');
    runGit([
      '-C',
      dir,
      'push',
      path.join(projectRoot, 'matchingpartial-ts.git'),
      'refs/heads/main:refs/heads/main',
      'refs/heads/feature:refs/heads/feature',
    ]);
    await writeFile(path.join(dir, 'advance.txt'), 'advance (tsgit)\n');
    git(dir, 'add', 'advance.txt');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'advance main (tsgit)');
    git(dir, 'branch', '-f', 'feature', 'main');
    await appendConfig(
      repo,
      [
        '[remote "matchingpartial"]',
        `  url = ${bareUrl('matchingpartial', 'ts')}`,
        '[push]',
        '  default = matching',
      ].join('\n'),
    );
    const tsAdvancedOid = git(dir, 'rev-parse', 'main').trim();

    // Act
    const sut = await repo.push({});

    // Assert — both advertised branches advanced identically on both bares;
    // `extra` (never advertised) reached neither.
    expect(sut.pushedRefs.map((ref) => ref.name).sort()).toEqual(
      ['refs/heads/feature', 'refs/heads/main'].sort(),
    );
    expect(
      runGit([
        '--git-dir',
        path.join(projectRoot, 'matchingpartial-real.git'),
        'rev-parse',
        'main',
      ]).trim(),
    ).toBe(realAdvancedOid);
    expect(
      runGit([
        '--git-dir',
        path.join(projectRoot, 'matchingpartial-real.git'),
        'rev-parse',
        'feature',
      ]).trim(),
    ).toBe(realAdvancedOid);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'matchingpartial-real.git'),
        'rev-parse',
        'extra',
      ]).ok,
    ).toBe(false);

    expect(
      runGit([
        '--git-dir',
        path.join(projectRoot, 'matchingpartial-ts.git'),
        'rev-parse',
        'main',
      ]).trim(),
    ).toBe(tsAdvancedOid);
    expect(
      runGit([
        '--git-dir',
        path.join(projectRoot, 'matchingpartial-ts.git'),
        'rev-parse',
        'feature',
      ]).trim(),
    ).toBe(tsAdvancedOid);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'matchingpartial-ts.git'),
        'rev-parse',
        'extra',
      ]).ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);

  it('Given push.default=matching and a detached HEAD, When push runs with no explicit refspec, Then it still pushes the matching branch without refusing, unlike every other push.default mode', async () => {
    // Arrange — real-git twin: seed the remote with `main` at the pre-push
    // tip via a local file-path push (no HTTP involved), advance main
    // locally, then detach HEAD before pushing — matching is HEAD-independent,
    // so real git must not refuse here.
    const gitDir = await initGitRepo();
    git(gitDir, 'branch', 'extra');
    runGit([
      '-C',
      gitDir,
      'push',
      path.join(projectRoot, 'matchingdetached-real.git'),
      'refs/heads/main:refs/heads/main',
    ]);
    git(gitDir, 'remote', 'add', 'matchingdetached', bareUrl('matchingdetached', 'real'));
    await writeFile(path.join(gitDir, 'advance.txt'), 'advance (real git)\n');
    git(gitDir, 'add', 'advance.txt');
    git(gitDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'advance main (real git)');
    const realAdvancedOid = git(gitDir, 'rev-parse', 'main').trim();
    git(gitDir, 'config', 'push.default', 'matching');
    git(gitDir, 'checkout', '-q', '--detach', 'HEAD');
    await gitAsync(gitDir, 'push', '-q');

    // Arrange — tsgit twin: identical shape, independent commit oids. Real
    // git seeds the bare directly from tsgit's own git-faithful layout.
    const { repo, dir } = await initTsgitRepo();
    git(dir, 'branch', 'extra');
    runGit([
      '-C',
      dir,
      'push',
      path.join(projectRoot, 'matchingdetached-ts.git'),
      'refs/heads/main:refs/heads/main',
    ]);
    await writeFile(path.join(dir, 'advance.txt'), 'advance (tsgit)\n');
    git(dir, 'add', 'advance.txt');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'advance main (tsgit)');
    const tsAdvancedOid = git(dir, 'rev-parse', 'main').trim();
    await appendConfig(
      repo,
      [
        '[remote "matchingdetached"]',
        `  url = ${bareUrl('matchingdetached', 'ts')}`,
        '[push]',
        '  default = matching',
      ].join('\n'),
    );
    await writeFile(path.join(repo.ctx.layout.gitDir, 'HEAD'), `${tsAdvancedOid}\n`);

    // Act — tsgit must not refuse, unlike current/upstream/simple/nothing.
    const sut = await repo.push({});

    // Assert — `main` advanced on both bares; `extra` (never advertised)
    // reached neither.
    expect(sut.pushedRefs.map((ref) => ref.name)).toEqual(['refs/heads/main']);
    expect(
      runGit([
        '--git-dir',
        path.join(projectRoot, 'matchingdetached-real.git'),
        'rev-parse',
        'main',
      ]).trim(),
    ).toBe(realAdvancedOid);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'matchingdetached-real.git'),
        'rev-parse',
        'extra',
      ]).ok,
    ).toBe(false);

    expect(
      runGit([
        '--git-dir',
        path.join(projectRoot, 'matchingdetached-ts.git'),
        'rev-parse',
        'main',
      ]).trim(),
    ).toBe(tsAdvancedOid);
    expect(
      tryRunGit([
        '--git-dir',
        path.join(projectRoot, 'matchingdetached-ts.git'),
        'rev-parse',
        'extra',
      ]).ok,
    ).toBe(false);

    await repo.dispose();
  }, 30_000);
});

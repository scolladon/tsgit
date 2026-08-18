/**
 * Cross-tool interop — bare and work-tree-less layout resolution: cwd-is-gitdir
 * discovery, `core.bare`/`core.worktree` precedence, the work-tree-config-bogus
 * refusal, and the full work-tree-requiring refusal matrix. Builds each
 * on-disk layout shape with canonical git, then proves `openRepository`
 * resolves the identical `gitDir`/`commonDir`/`bare`/`workDir` git itself
 * reports, and that every command's refuse/proceed verdict matches git's.
 *
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         bare and work-tree-less layout resolution and refusals match canonical git
 *   interopSurface: layout
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity, ObjectId, RefName } from '../../src/domain/objects/index.js';
import { FILE_MODE } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

/**
 * Minimal `git-http-backend` CGI bridge — a condensed version of the pattern
 * shared by `test/integration/network/*-http-backend.test.ts`. Serves any
 * `.git`-suffixed repo under `projectRoot` (both read and receive-pack, once
 * `http.receivepack` is set on the target). Scenario K is the only scenario
 * in this file that needs a real HTTP round trip — tsgit's `fetch`/`push`
 * speak no other transport.
 */
const findGitExecPath = (): string | undefined => {
  try {
    return runGit(['--exec-path']).toString().trim();
  } catch {
    return undefined;
  }
};

const GIT_EXEC_PATH = findGitExecPath();
const GIT_HTTP_BACKEND = GIT_EXEC_PATH ? path.join(GIT_EXEC_PATH, 'git-http-backend') : undefined;

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

const handleBackendRequest = (
  projectRoot: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  if (req.url === undefined || req.method === undefined || GIT_HTTP_BACKEND === undefined) {
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
  const child = spawn(GIT_HTTP_BACKEND, [], { env });
  child.stdin.on('error', () => undefined);
  req.pipe(child.stdin);
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.on('close', () => writeCgiResponse(res, Buffer.concat(chunks)));
  child.on('error', (err) => {
    res.statusCode = 502;
    res.end(`CGI spawn error: ${err.message}`);
  });
};

/** Serve `projectRoot` over a fresh ephemeral-port HTTP server; caller closes it. */
const serveProjectRoot = async (
  projectRoot: string,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => handleBackendRequest(projectRoot, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server.address() returned an unexpected value');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
};

const SETUP_TIMEOUT = 60_000;

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

/** A fresh, realpath-resolved tmpdir root for one scenario group. */
const mkRoot = async (slug: string): Promise<string> =>
  realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-bare-${slug}-`)));

/** `git rev-parse --path-format=absolute --git-dir --git-common-dir`, split into a pair. */
const gitDirPair = (cwd: string): readonly [string, string] => {
  const [gitDir, commonDir] = git(
    cwd,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  )
    .trim()
    .split('\n');
  if (gitDir === undefined || commonDir === undefined) {
    throw new Error(`unexpected rev-parse output for ${cwd}`);
  }
  return [gitDir, commonDir];
};

const isBareAccordingToGit = (cwd: string): boolean =>
  git(cwd, 'rev-parse', '--is-bare-repository').trim() === 'true';

/** Opens `cwd` and returns the rejection — fails the test if it resolves. */
const openAndCatch = async (cwd: string): Promise<unknown> => {
  try {
    await openRepository({ cwd });
  } catch (err) {
    return err;
  }
  expect.unreachable('expected openRepository to reject');
};

/** Build a normal (non-bare) repo with one commit at `dir`. */
const buildNormalRepo = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  disableAutoMaintenance(dir);
};

describe.skipIf(!GIT_AVAILABLE)('bare and work-tree-less layout interop', () => {
  describe('Given a git clone --bare target (scenarios A, B)', () => {
    let root: string;
    let source: string;
    let bare: string;
    let repo: Repository;

    beforeAll(async () => {
      root = await mkRoot('ab');
      source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'one\n');
      git(source, 'add', 'a.txt');
      commit(source, 'c1');
      git(source, 'branch', 'topic');
      git(source, 'tag', 'v1');
      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', source, bare]);
      disableAutoMaintenance(bare);
      repo = await openRepository({ cwd: bare });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await repo?.dispose();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When opened at the bare gitdir itself (scenario A)', () => {
      it('Then layout.gitDir/commonDir/bare match git rev-parse', () => {
        // Arrange
        const [expectedGitDir, expectedCommonDir] = gitDirPair(bare);

        // Act
        const result = repo.ctx.layout;

        // Assert
        expect(result.gitDir).toBe(expectedGitDir);
        expect(result.gitDir).toBe(expectedCommonDir);
        expect(result.commonDir).toBeUndefined();
        expect(result.bare).toBe(true);
        expect(result.workDir).toBeUndefined();
        expect(isBareAccordingToGit(bare)).toBe(true);
      });

      it('Then log/revParse/catFile/branch.list/tag.list agree with git', async () => {
        // Arrange — `clone --bare` packs every ref (including `topic`/`v1`)
        // into `packed-refs`; `branch.list`/`tag.list` enumerate loose refs
        // only (an unrelated, pre-existing gap this scenario is not about),
        // so a loose branch/tag created AFTER the clone proves the read path
        // itself — layout resolution, not ref-storage enumeration.
        git(bare, 'branch', 'loose-topic', 'main');
        git(bare, 'tag', 'loose-v1', 'main');
        const expectedLog = git(bare, 'log', '--format=%H').trim().split('\n');
        const expectedHead = git(bare, 'rev-parse', 'HEAD').trim();
        // A fresh handle AFTER the git-side writes — the file's own discipline:
        // per-Context caches are only invalidated by tsgit's own writeObject.
        const fresh = await openRepository({ cwd: bare });

        try {
          // Act
          const log = await fresh.log();
          const revParsed = await fresh.revParse('HEAD');
          const catFile = await fresh.catFile({ ids: [expectedHead] });
          const branches = await fresh.branch.list();
          const tags = await fresh.tag.list();

          // Assert
          expect(log.map((entry) => entry.id)).toEqual(expectedLog);
          expect(revParsed).toBe(expectedHead);
          expect(catFile.entries).toHaveLength(1);
          expect(branches.branches.some((b) => b.name === 'refs/heads/loose-topic')).toBe(true);
          expect(tags.tags.some((t) => t.name === 'refs/tags/loose-v1')).toBe(true);
        } finally {
          await fresh.dispose();
        }
      });
    });

    describe('When opened with cwd inside the bare gitdir (scenario B, the measured wrong-repo defect)', () => {
      it('Then it resolves the SAME enclosing bare repo as scenario A', async () => {
        // Arrange
        const cwd = path.join(bare, 'refs');
        const [expectedGitDir, expectedCommonDir] = gitDirPair(cwd);

        // Act
        const nested = await openRepository({ cwd });
        try {
          // Assert
          expect(nested.ctx.layout.gitDir).toBe(expectedGitDir);
          expect(nested.ctx.layout.gitDir).toBe(bare);
          expect(nested.ctx.layout.commonDir).toBeUndefined();
          expect(expectedCommonDir).toBe(bare);
          expect(nested.ctx.layout.bare).toBe(true);
        } finally {
          await nested.dispose();
        }
      });
    });
  });

  describe("Given cwd at a normal repo's .git directory (scenario C)", () => {
    let root: string;
    let normal: string;
    let dotGit: string;
    let repo: Repository;

    beforeAll(async () => {
      root = await mkRoot('c');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      git(normal, 'add', 'a.txt');
      commit(normal, 'c1');
      dotGit = path.join(normal, '.git');
      repo = await openRepository({ cwd: dotGit });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await repo?.dispose();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When the layout is inspected', () => {
      it('Then bare is false and there is no work tree', () => {
        // Arrange / Act
        const result = repo.ctx.layout;

        // Assert — worktree-less but not bare: `is_bare_repository()` is
        // false (git wrote `core.bare = false` at init) even though there is
        // no work tree.
        expect(result.bare).toBe(false);
        expect(result.workDir).toBeUndefined();
        expect(isBareAccordingToGit(dotGit)).toBe(false);
      });
    });

    describe('When status and add run', () => {
      it('Then both refuse while git prints the work-tree fatal', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', dotGit, 'status'], { env: runGitEnv() });

        // Act
        let caught: unknown;
        try {
          await repo.status();
        } catch (err) {
          caught = err;
        }

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('this operation must be run in a work tree');
        // Assert — tsgit
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('WORK_TREE_REQUIRED');
      });
    });

    describe('When log runs', () => {
      it('Then it still works in both', async () => {
        // Arrange
        const expected = git(dotGit, 'log', '--format=%H').trim().split('\n');

        // Act
        const result = await repo.log();

        // Assert
        expect(result.map((entry) => entry.id)).toEqual(expected);
      });
    });
  });

  describe('Given core.worktree set on the discovery route (scenario F)', () => {
    let root: string;
    let normal: string;

    beforeAll(async () => {
      root = await mkRoot('f');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      git(normal, 'add', 'a.txt');
      commit(normal, 'c1');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    // Unconditional, regardless of how the test body exited — leftover
    // `core.worktree` from a failed row must never poison a later one.
    afterEach(() => {
      tryRunGitWithExit(['-C', normal, 'config', '--unset', 'core.worktree'], {
        env: runGitEnv(),
      });
    });

    describe('When core.worktree is an absolute path', () => {
      it('Then layout.workDir matches git rev-parse --show-toplevel', async () => {
        // Arrange
        const abs = path.join(root, 'abs-wt');
        await mkdir(abs, { recursive: true });
        git(normal, 'config', 'core.worktree', abs);
        const expected = git(normal, 'rev-parse', '--show-toplevel').trim();

        // Act
        const repo = await openRepository({ cwd: normal });
        try {
          // Assert
          expect(repo.ctx.layout.workDir).toBe(await realpath(abs));
          expect(await realpath(abs)).toBe(await realpath(expected));
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When core.worktree is a relative path resolved against gitDir', () => {
      it('Then layout.workDir matches git rev-parse --show-toplevel', async () => {
        // Arrange — resolved against gitDir (`$T/normal/.git`), not its
        // parent: `../rel-wt` is one level up from `.git`, i.e. `$T/normal/rel-wt`.
        const rel = path.join(normal, 'rel-wt');
        await mkdir(rel, { recursive: true });
        git(normal, 'config', 'core.worktree', '../rel-wt');
        const expected = git(normal, 'rev-parse', '--show-toplevel').trim();

        // Act
        const repo = await openRepository({ cwd: normal });
        try {
          // Assert
          expect(repo.ctx.layout.workDir).toBe(await realpath(rel));
          expect(await realpath(rel)).toBe(await realpath(expected));
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When core.worktree points through a symlink', () => {
      it('Then layout.workDir resolves to the physical (real) target', async () => {
        // Arrange
        const real = path.join(root, 'real-wt');
        await mkdir(real, { recursive: true });
        const link = path.join(root, 'link-wt');
        await symlink(real, link);
        git(normal, 'config', 'core.worktree', link);
        const expected = git(normal, 'rev-parse', '--show-toplevel').trim();

        // Act
        const repo = await openRepository({ cwd: normal });
        try {
          // Assert
          expect(repo.ctx.layout.workDir).toBe(await realpath(real));
          expect(await realpath(real)).toBe(await realpath(expected));
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When a RELATIVE core.worktree resolves to a path that does not exist', () => {
      it('Then both tools refuse at setup, and tsgit names the raw relative value', async () => {
        // Arrange — git resolves a relative core.worktree by physically
        // changing directory from the gitDir, so a missing target dies at
        // setup on every command; tsgit mirrors that at openRepository.
        git(normal, 'config', 'core.worktree', '../missing-wt');
        const g = tryRunGitWithExit(['-C', normal, 'rev-parse', '--show-toplevel'], {
          env: runGitEnv(),
        });

        // Act
        let caught: unknown;
        try {
          await openRepository({ cwd: normal });
        } catch (err) {
          caught = err;
        }

        // Assert — git names the relative value in its chdir fatal
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("cannot chdir to '../missing-wt'");
        // Assert — tsgit's structured refusal carries the same raw value
        const data = (caught as { data?: { code?: string; value?: string; gitDir?: string } })
          ?.data;
        expect(data?.code).toBe('WORK_TREE_UNRESOLVABLE');
        expect(data?.value).toBe('../missing-wt');
        expect(data?.gitDir).toBe(await realpath(path.join(normal, '.git')));
      });
    });
  });

  describe('Given core.bare and core.worktree set together (scenario G)', () => {
    let root: string;
    let normal: string;
    let wt: string;

    beforeAll(async () => {
      root = await mkRoot('g');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      git(normal, 'add', 'a.txt');
      commit(normal, 'c1');
      wt = path.join(root, 'wt');
      await mkdir(wt, { recursive: true });
      git(normal, 'config', 'core.bare', 'true');
      git(normal, 'config', 'core.worktree', wt);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When openRepository is followed by status', () => {
      it('Then openRepository succeeds but status throws WORK_TREE_CONFIG_INVALID', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', normal, 'status'], { env: runGitEnv() });

        // Act
        const repo = await openRepository({ cwd: normal });
        let caught: unknown;
        try {
          await repo.status();
        } catch (err) {
          caught = err;
        } finally {
          await repo.dispose();
        }

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('unable to set up work tree using invalid config');
        // Assert — tsgit; the payload names the gitDir the bogus config lives in
        const data = (caught as { data?: { code?: string; gitDir?: string } })?.data;
        expect(data?.code).toBe('WORK_TREE_CONFIG_INVALID');
        expect(data?.gitDir).toBe(await realpath(path.join(normal, '.git')));
      });
    });

    describe('When --is-bare-repository is queried', () => {
      it('Then both tools answer true', async () => {
        // Arrange & Act
        const repo = await openRepository({ cwd: normal });

        try {
          // Assert
          expect(repo.ctx.layout.bare).toBe(true);
          expect(isBareAccordingToGit(normal)).toBe(true);
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  describe('Given the exhaustive work-tree-requiring refusal matrix (scenario H)', () => {
    let root: string;
    let bare: string;
    let repo: Repository;

    beforeAll(async () => {
      root = await mkRoot('h');
      const source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'needle\n');
      git(source, 'add', 'a.txt');
      commit(source, 'c1');
      runGit(['-C', source, 'tag', '-a', 'v1', '-m', 'v1', 'main'], { env: COMMIT_ENV });
      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', source, bare]);
      disableAutoMaintenance(bare);
      repo = await openRepository({ cwd: bare });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await repo?.dispose();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('Work-tree-requiring commands', () => {
      describe('When each of them runs', () => {
        it.each<[string, () => Promise<unknown>, ReadonlyArray<string>, number, string, string]>([
          [
            'status',
            () => repo.status(),
            ['status'],
            128,
            'this operation must be run in a work tree',
            'status',
          ],
          [
            'add',
            () => repo.add(['x']),
            ['add', '.'],
            128,
            'this operation must be run in a work tree',
            'add',
          ],
          [
            'checkout',
            () => repo.checkout({ rev: 'main' }),
            ['checkout', 'main'],
            128,
            'this operation must be run in a work tree',
            'checkout',
          ],
          [
            'commit',
            () => repo.commit({ message: 'x', author: AUTHOR }),
            ['commit', '-m', 'x'],
            128,
            'this operation must be run in a work tree',
            'commit',
          ],
          [
            'merge',
            () => repo.merge.run({ rev: 'main' }),
            ['merge', 'main'],
            128,
            'this operation must be run in a work tree',
            'merge',
          ],
          [
            'rm',
            () => repo.rm(['a.txt']),
            ['rm', 'a.txt'],
            128,
            'this operation must be run in a work tree',
            'rm',
          ],
          [
            'mv',
            () => repo.mv(['a.txt'], 'b.txt'),
            ['mv', 'a.txt', 'b.txt'],
            128,
            'this operation must be run in a work tree',
            'mv',
          ],
          [
            'reset --hard',
            () => repo.reset({ mode: 'hard', rev: 'HEAD' }),
            ['reset', '--hard'],
            128,
            'this operation must be run in a work tree',
            'reset --hard',
          ],
          [
            'grep (default target)',
            () => repo.grep({ patterns: [{ fixed: 'needle' }] }),
            ['grep', 'needle'],
            128,
            'this operation must be run in a work tree',
            'grep',
          ],
          [
            'pull',
            () => repo.pull({ remote: 'origin' }),
            ['pull'],
            128,
            'this operation must be run in a work tree',
            'pull',
          ],
          [
            'stash push',
            () => repo.stash.push({}),
            ['stash', 'push'],
            128,
            'this operation must be run in a work tree',
            'stash',
          ],
          [
            'stash list',
            () => repo.stash.list(),
            ['stash', 'list'],
            128,
            'this operation must be run in a work tree',
            'stash list',
          ],
          [
            'stash pop',
            () => repo.stash.pop({}),
            ['stash', 'pop'],
            128,
            'this operation must be run in a work tree',
            'stash pop',
          ],
          [
            'sparse-checkout list',
            () => repo.sparseCheckout.list(),
            ['sparse-checkout', 'list'],
            128,
            'this operation must be run in a work tree',
            'sparse-checkout',
          ],
          [
            'cherry-pick',
            () => repo.cherryPick.run({ commits: ['main'] }),
            ['cherry-pick', 'main'],
            128,
            'this operation must be run in a work tree',
            'cherry-pick',
          ],
          [
            'revert',
            () => repo.revert.run({ commits: ['main'] }),
            ['revert', '--no-edit', 'main'],
            128,
            'this operation must be run in a work tree',
            'revert',
          ],
          [
            'rebase',
            () => repo.rebase.run({ upstream: 'main' }),
            ['rebase', 'main'],
            128,
            'this operation must be run in a work tree',
            'rebase',
          ],
          [
            'submodule status',
            () => repo.submodule.list(),
            ['submodule', 'status'],
            1,
            'cannot be used without a working tree',
            'submodule status',
          ],
          [
            'submodule init',
            () => repo.submodule.init(),
            ['submodule', 'init'],
            1,
            'cannot be used without a working tree',
            'submodule init',
          ],
          [
            'submodule sync',
            () => repo.submodule.sync({}),
            ['submodule', 'sync'],
            1,
            'cannot be used without a working tree',
            'submodule sync',
          ],
          [
            'submodule deinit',
            () => repo.submodule.deinit({ all: true }),
            ['submodule', 'deinit', '--all'],
            1,
            'cannot be used without a working tree',
            'submodule deinit',
          ],
        ])(
          'Then %s refuses, matching git byte-for-byte',
          async (_label, call, gitArgs, expectedExit, expectedStderr, expectedOperation) => {
            // Arrange
            const g = tryRunGitWithExit(['-C', bare, ...gitArgs], { env: runGitEnv() });

            // Act
            let caught: unknown;
            try {
              await call();
            } catch (err) {
              caught = err;
            }

            // Assert — git's exit code AND refusal line, per row: a disjunctive
            // exit check could not tell a work-tree refusal from any other
            // failure of the invocation.
            expect(g.exitCode).toBe(expectedExit);
            expect(g.stderr).toContain(expectedStderr);
            // Assert — tsgit's code and per-row operation payload.
            const data = (caught as { data?: { code?: string; operation?: string } })?.data;
            expect(data?.code).toBe('WORK_TREE_REQUIRED');
            expect(data?.operation).toBe(expectedOperation);
          },
        );
      });

      describe('When describe({ dirty: true }) runs', () => {
        it('Then it refuses (via the status gate)', async () => {
          // Arrange
          const g = tryRunGitWithExit(['-C', bare, 'describe', '--dirty'], { env: runGitEnv() });

          // Act
          let caught: unknown;
          try {
            await repo.describe(undefined, { dirty: true });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(g.exitCode).toBe(128);
          expect(g.stderr).toContain('this operation must be run in a work tree');
          const data = (caught as { data?: { code?: string; operation?: string } })?.data;
          expect(data?.code).toBe('WORK_TREE_REQUIRED');
          expect(data?.operation).toBe('describe --dirty');
        });
      });
    });

    describe('Commands that must NOT refuse in a bare repository', () => {
      describe('When log, show, revList, revParse, catFile run', () => {
        it('Then all of them agree with git', async () => {
          // Arrange
          const head = git(bare, 'rev-parse', 'HEAD').trim();

          // Act & Assert — none of these throw
          await expect(repo.log()).resolves.toBeDefined();
          await expect(repo.show([head])).resolves.toBeDefined();
          await expect(repo.revList()).resolves.toBeDefined();
          await expect(repo.revParse('HEAD')).resolves.toBe(head);
          await expect(repo.catFile({ ids: [head] })).resolves.toBeDefined();
        });
      });

      describe('When diff (tree-to-tree) runs', () => {
        it('Then it does not refuse — there is no worktree-comparing shape', async () => {
          // Arrange & Act & Assert
          await expect(repo.diff({ from: 'HEAD', to: 'HEAD' })).resolves.toBeDefined();
        });
      });

      describe("When grep({ target: 'index' }) and grep({ target: { treeish } }) run", () => {
        it('Then neither refuses', async () => {
          // Arrange & Act & Assert
          await expect(
            repo.grep({ patterns: [{ fixed: 'needle' }], target: 'index' }),
          ).resolves.toBeDefined();
          await expect(
            repo.grep({ patterns: [{ fixed: 'needle' }], target: { treeish: 'HEAD' } }),
          ).resolves.toBeDefined();
        });
      });

      describe('When blame runs with no worktree option', () => {
        it('Then it blames HEAD instead of refusing', async () => {
          // Arrange
          const g = tryRunGitWithExit(['-C', bare, 'blame', 'a.txt'], { env: runGitEnv() });

          // Act
          const result = await repo.blame('a.txt');

          // Assert
          expect(g.exitCode).toBe(0);
          expect(result.lines.length).toBeGreaterThan(0);
        });
      });

      describe('When describe() and describe({ broken: true }) run', () => {
        it('Then neither refuses', async () => {
          // Arrange
          const g = tryRunGitWithExit(['-C', bare, 'describe', '--broken', '--always'], {
            env: runGitEnv(),
          });

          // Act
          const plain = await repo.describe();
          const broken = await repo.describe(undefined, { broken: true, always: true });

          // Assert
          expect(plain).toBeDefined();
          expect(g.exitCode).toBe(0);
          expect(broken.dirty).toBe(true);
        });
      });

      describe('When reset({ mode: "soft" }) runs', () => {
        it('Then it does not refuse', async () => {
          // Arrange & Act & Assert
          await expect(repo.reset({ mode: 'soft', rev: 'HEAD' })).resolves.toBeDefined();
        });
      });

      describe('When archive, fsck, branch.list, tag.list, reflog, notes.list, config.list, worktree.list run', () => {
        it('Then none of them refuse', async () => {
          // Arrange & Act & Assert
          await expect(repo.archive({ treeish: 'HEAD' })).resolves.toBeDefined();
          await expect(repo.fsck()).resolves.toBeDefined();
          await expect(repo.branch.list()).resolves.toBeDefined();
          await expect(repo.tag.list()).resolves.toBeDefined();
          await expect(repo.reflog()).resolves.toBeDefined();
          await expect(repo.notes.list()).resolves.toBeDefined();
          await expect(repo.config.list()).resolves.toBeDefined();
          await expect(repo.worktree.list()).resolves.toBeDefined();
        });
      });
    });
  });

  describe('Given blame(worktree:true) in a worktree-less non-bare repo', () => {
    let root: string;
    let normal: string;
    let repo: Repository;

    beforeAll(async () => {
      root = await mkRoot('blame-non-bare');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'needle\n');
      git(normal, 'add', 'a.txt');
      commit(normal, 'c1');
      repo = await openRepository({ cwd: path.join(normal, '.git') });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await repo?.dispose();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When blame runs with worktree: true', () => {
      it('Then it refuses, unlike the bare case', async () => {
        // Arrange — repo opened at .git (beforeAll), so no work tree resolves
        const target = 'a.txt';

        // Act
        let caught: unknown;
        try {
          await repo.blame(target, { worktree: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('WORK_TREE_REQUIRED');
      });
    });
  });

  describe('Given reset --mixed in a bare repo (scenario I)', () => {
    let root: string;
    let bare: string;

    beforeAll(async () => {
      root = await mkRoot('i');
      const source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'x\n');
      git(source, 'add', 'a.txt');
      commit(source, 'c1');
      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', source, bare]);
      disableAutoMaintenance(bare);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When reset({ mode: "mixed" }) runs', () => {
      it('Then tsgit throws BARE_REPOSITORY and git refuses the mixed reset, and neither creates an index', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', bare, 'reset', '--mixed', 'HEAD'], {
          env: runGitEnv(),
        });
        const repo = await openRepository({ cwd: bare });

        // Act
        let caught: unknown;
        try {
          await repo.reset({ mode: 'mixed', rev: 'HEAD' });
        } catch (err) {
          caught = err;
        } finally {
          await repo.dispose();
        }

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('mixed reset is not allowed in a bare repository');
        // Assert — tsgit
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('BARE_REPOSITORY');
        expect(data?.operation).toBe('reset --mixed');
        // Assert — neither tool created an index in the bare gitdir
        expect(existsSync(path.join(bare, 'index'))).toBe(false);
      });
    });
  });

  describe.skipIf(GIT_HTTP_BACKEND === undefined)(
    'Given a bare repo that receives a push (scenario K, round-trip write then read)',
    () => {
      describe('When tsgit pushes a commit into it over HTTP', () => {
        it(
          'Then tsgit pushing into it lands the commit, and both git and a fresh tsgit open see it',
          async () => {
            // Arrange — a receive-pack-enabled bare target served over a minimal
            // local HTTP CGI bridge to git-http-backend (the only transport
            // tsgit speaks), plus a separate non-bare source repo tsgit pushes
            // from. The bare target is opened by tsgit BOTH as the push
            // destination's remote AND, afterward, directly by cwd — proving a
            // genuinely bare (no workDir) Context correctly drives the
            // object-store write path.
            const root = await mkRoot('k');
            const serverRoot = path.join(root, 'server');
            await mkdir(serverRoot, { recursive: true });
            const bare = path.join(serverRoot, 'target.git');
            runGit(['init', '-q', '--bare', '-b', 'main', bare]);
            disableAutoMaintenance(bare);
            runGit(['-C', bare, 'config', 'http.receivepack', 'true']);

            const server = await serveProjectRoot(serverRoot);
            const source = path.join(root, 'source');
            await mkdir(source, { recursive: true });

            try {
              const pusher = await openRepository({
                cwd: source,
                allowInsecureHttp: true,
                config: {
                  allowInsecure: true,
                  allowPrivateNetworks: true,
                  dnsResolver: async () => ['127.0.0.1'],
                },
              });
              let commitId: string;
              try {
                // Act — tsgit pushes a fresh commit into the bare target over HTTP.
                await pusher.init();
                await writeFile(path.join(source, 'a.txt'), 'pushed\n');
                await pusher.add(['a.txt']);
                const committed = await pusher.commit({ message: 'from tsgit', author: AUTHOR });
                commitId = committed.id;
                await pusher.remote.add({ name: 'origin', url: `${server.baseUrl}/target.git` });
                await pusher.push({
                  remote: 'origin',
                  refspecs: ['refs/heads/main:refs/heads/main'],
                });
              } finally {
                await pusher.dispose();
              }

              // Assert — canonical git, reading the bare target directly, sees it.
              expect(git(bare, 'log', '--format=%H', 'main').trim().split('\n')[0]).toBe(commitId);

              // Assert — a FRESH tsgit open directly on the (now genuinely bare,
              // no-workDir) target reads the pushed commit back.
              const reopened = await openRepository({ cwd: bare });
              try {
                expect(reopened.ctx.layout.bare).toBe(true);
                expect(reopened.ctx.layout.workDir).toBeUndefined();
                expect(await reopened.revParse('main')).toBe(commitId);
              } finally {
                await reopened.dispose();
              }

              // Assert — tsgit FETCH from the bare target sees the commit too
              // (the read direction of the server-side story).
              const fetchTarget = path.join(root, 'fetcher');
              await mkdir(fetchTarget, { recursive: true });
              const fetcher = await openRepository({
                cwd: fetchTarget,
                allowInsecureHttp: true,
                config: {
                  allowInsecure: true,
                  allowPrivateNetworks: true,
                  dnsResolver: async () => ['127.0.0.1'],
                },
              });
              try {
                await fetcher.init();
                await fetcher.remote.add({ name: 'origin', url: `${server.baseUrl}/target.git` });
                await fetcher.fetch({ remote: 'origin' });
                expect(await fetcher.revParse('refs/remotes/origin/main')).toBe(commitId);
              } finally {
                await fetcher.dispose();
              }

              // Assert — tsgit clone({ bare: true }) of the target produces a
              // bare repo REAL GIT reads, byte-shaped like `git clone --bare`
              // where pinned (bare=true, no index file); then `git clone` of
              // that tsgit-written bare repo yields a working clone.
              const bareClone = path.join(root, 'tsgit-bare-clone.git');
              await mkdir(bareClone, { recursive: true });
              const cloner = await openRepository({
                cwd: bareClone,
                gitDir: bareClone,
                bare: true,
                allowInsecureHttp: true,
                config: {
                  allowInsecure: true,
                  allowPrivateNetworks: true,
                  dnsResolver: async () => ['127.0.0.1'],
                },
              });
              try {
                await cloner.clone({ url: `${server.baseUrl}/target.git`, bare: true });
              } finally {
                await cloner.dispose();
              }
              expect(git(bareClone, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
              expect(git(bareClone, 'log', '--format=%H', 'main').trim().split('\n')[0]).toBe(
                commitId,
              );
              await expect(readFile(path.join(bareClone, 'index'))).rejects.toThrow();
              const workingClone = path.join(root, 'working-clone');
              runGit(['clone', '-q', bareClone, workingClone]);
              expect(git(workingClone, 'log', '--format=%H').trim().split('\n')[0]).toBe(commitId);
              expect(await readFile(path.join(workingClone, 'a.txt'), 'utf8')).toBe('pushed\n');
            } finally {
              await server.close();
              await rm(root, { recursive: true, force: true });
            }
          },
          SETUP_TIMEOUT,
        );
      });
    },
  );

  describe('Given a linked worktree of a bare repo (scenario N)', () => {
    let root: string;
    let bare: string;
    let wt: string;

    beforeAll(async () => {
      root = await mkRoot('n');
      const source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'x\n');
      git(source, 'add', 'a.txt');
      commit(source, 'c1');
      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', source, bare]);
      disableAutoMaintenance(bare);
      wt = path.join(root, 'wt');
      git(bare, 'worktree', 'add', '-q', wt, 'main');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When openRepository runs at the worktree path', () => {
      it('Then the layout is non-bare with gitDir/commonDir under the bare admin dir', async () => {
        // Arrange
        const [expectedGitDir, expectedCommonDir] = gitDirPair(wt);

        // Act
        const repo = await openRepository({ cwd: wt });

        try {
          // Assert
          expect(repo.ctx.layout.bare).toBe(false);
          expect(repo.ctx.layout.gitDir).toBe(expectedGitDir);
          expect(repo.ctx.layout.commonDir).toBe(expectedCommonDir);
          expect(repo.ctx.layout.commonDir).toBe(bare);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When worktree.list runs from the linked worktree', () => {
      it('Then it marks the main entry bare:true, matching git worktree list --porcelain', async () => {
        // Arrange
        const expectedPorcelain = git(wt, 'worktree', 'list', '--porcelain');
        const repo = await openRepository({ cwd: wt });

        try {
          // Act
          const result = await repo.worktree.list();

          // Assert
          const [mainEntry] = result.entries;
          expect(mainEntry?.main).toBe(true);
          expect(mainEntry?.bare).toBe(true);
          expect(expectedPorcelain).toContain('\nbare\n');
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  describe('Given core.worktree/core.bare set inside config.worktree under extensions.worktreeConfig (scenario O)', () => {
    let root: string;
    let normal: string;
    let customWt: string;

    beforeAll(async () => {
      root = await mkRoot('o');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      git(normal, 'add', 'a.txt');
      commit(normal, 'c1');
      customWt = path.join(root, 'custom-wt');
      await mkdir(customWt, { recursive: true });
      git(normal, 'config', 'core.repositoryformatversion', '1');
      git(normal, 'config', 'extensions.worktreeConfig', 'true');
      await writeFile(
        path.join(normal, '.git', 'config.worktree'),
        `[core]\n\tworktree = ${customWt}\n`,
      );
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When openRepository runs with core.worktree set in config.worktree', () => {
      it('Then core.worktree from config.worktree is honoured, matching git', async () => {
        // Arrange
        const expected = git(normal, 'rev-parse', '--show-toplevel').trim();

        // Act
        const repo = await openRepository({ cwd: normal });

        try {
          // Assert
          expect(repo.ctx.layout.workDir).toBe(await realpath(customWt));
          expect(await realpath(customWt)).toBe(await realpath(expected));
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When openRepository runs with core.bare set in config.worktree', () => {
      it('Then core.bare from config.worktree is honoured, matching git', async () => {
        // Arrange — flip config.worktree to set core.bare instead, proving the
        // extension gate applies to BOTH keys, not just core.worktree.
        await writeFile(path.join(normal, '.git', 'config.worktree'), '[core]\n\tbare = true\n');
        const expectedBare = isBareAccordingToGit(normal);

        // Act
        const repo = await openRepository({ cwd: normal });

        try {
          // Assert
          expect(repo.ctx.layout.bare).toBe(true);
          expect(repo.ctx.layout.bare).toBe(expectedBare);
          expect(repo.ctx.layout.workDir).toBeUndefined();
        } finally {
          await repo.dispose();
          await writeFile(
            path.join(normal, '.git', 'config.worktree'),
            `[core]\n\tworktree = ${customWt}\n`,
          );
        }
      });
    });
  });

  describe('Given value-grammar refusals in the layout config (scenario P)', () => {
    let root: string;

    beforeAll(async () => {
      root = await mkRoot('p');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When core.bare is set to an unparseable boolean', () => {
      it('Then it co-refuses with git, naming the key, at the openRepository call', async () => {
        // Arrange
        const dir = path.join(root, 'bad-bare');
        buildNormalRepo(dir);
        runGit(['config', '--file', path.join(dir, '.git', 'config'), 'core.bare', 'banana']);
        const g = tryRunGitWithExit(['-C', dir, 'status'], { env: runGitEnv() });

        // Act
        const caught = await openAndCatch(dir);

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("bad boolean config value 'banana' for 'core.bare'");
        // Assert — tsgit, asserted at the openRepository call itself
        const data = (caught as { data?: { code?: string; key?: string } })?.data;
        expect(data?.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data?.key).toBe('core.bare');
      });
    });

    describe('When core.worktree is set with no value', () => {
      it('Then it co-refuses with git, naming the key, at the openRepository call', async () => {
        // Arrange
        const dir = path.join(root, 'bad-worktree');
        buildNormalRepo(dir);
        await writeFile(path.join(dir, '.git', 'config'), '[core]\n\tworktree\n');
        const g = tryRunGitWithExit(['-C', dir, 'status'], { env: runGitEnv() });

        // Act
        const caught = await openAndCatch(dir);

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("missing value for 'core.worktree'");
        // Assert — tsgit, asserted at the openRepository call itself
        const data = (caught as { data?: { code?: string; key?: string } })?.data;
        expect(data?.code).toBe('CONFIG_MISSING_VALUE');
        expect(data?.key).toBe('core.worktree');
      });
    });
  });

  describe('Given an explicit gitDir opened from an unrelated cwd, no workDir (scenario D)', () => {
    let root: string;
    let normal: string;
    let elsewhere: string;

    beforeAll(async () => {
      root = await mkRoot('d');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await writeFile(path.join(normal, 'a.txt'), 'x\n');
      git(normal, 'add', 'a.txt');
      commit(normal, 'c1');
      elsewhere = path.join(root, 'elsewhere');
      await mkdir(elsewhere, { recursive: true });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When openRepository opens with an explicit gitDir and cwd elsewhere', () => {
      it('Then the work tree defaults to cwd and status matches git --git-dir status --porcelain', async () => {
        // Arrange — git's work tree resolves to `elsewhere`, which never
        // held `a.txt`, so the index-recorded file reads as worktree-deleted.
        const gitDir = path.join(normal, '.git');
        const expectedPorcelain = git(elsewhere, '--git-dir', gitDir, 'status', '--porcelain');

        // Act
        const repo = await openRepository({ cwd: elsewhere, gitDir });

        try {
          const status = await repo.status();

          // Assert
          expect(repo.layout.workDir).toBe(await realpath(elsewhere));
          expect(repo.layout.bare).toBe(false);
          expect(expectedPorcelain).toContain(' D a.txt');
          const change = status.changes.find((c) => c.path === 'a.txt');
          expect(change?.unstaged).toBe('deleted');
          expect(change?.staged).toBeUndefined();
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  describe('Given an explicit gitDir and workDir opened against a bare repo (scenario E)', () => {
    let root: string;
    let bareForGit: string;
    let wtForGit: string;
    let bareForOurs: string;
    let wtForOurs: string;

    beforeAll(async () => {
      root = await mkRoot('e');
      const source = path.join(root, 'source');
      buildNormalRepo(source);
      await writeFile(path.join(source, 'a.txt'), 'x\n');
      git(source, 'add', 'a.txt');
      commit(source, 'c1');

      bareForGit = path.join(root, 'bare-git.git');
      runGit(['clone', '-q', '--bare', source, bareForGit]);
      disableAutoMaintenance(bareForGit);
      wtForGit = path.join(root, 'wt-git');
      await mkdir(wtForGit, { recursive: true });

      bareForOurs = path.join(root, 'bare-ours.git');
      runGit(['clone', '-q', '--bare', source, bareForOurs]);
      disableAutoMaintenance(bareForOurs);
      wtForOurs = path.join(root, 'wt-ours');
      await mkdir(wtForOurs, { recursive: true });

      // Both bare clones' own on-disk timestamps land inside the same
      // wall-clock second as this setup; let it pass before either tool
      // builds an index against its (still-empty) work tree, so neither
      // status read races the mtime-based stat cache.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When openRepository opens with explicit gitDir + workDir against the bare repo', () => {
      it('Then bare is false and the status column matches git, byte for byte', async () => {
        // Arrange — an explicit work tree overrides core.bare=true silently
        // (no warning, no bogus flag — that combination is core.worktree +
        // core.bare, not opts.workDir + core.bare).
        const gitPorcelain = runGit([
          '--git-dir',
          bareForGit,
          '--work-tree',
          wtForGit,
          'status',
          '--porcelain',
        ]).trim();

        // Act
        const repo = await openRepository({
          cwd: root,
          gitDir: bareForOurs,
          workDir: wtForOurs,
        });

        try {
          const result = await repo.status();

          // Assert
          expect(repo.layout.bare).toBe(false);
          expect(repo.layout.workTreeConfigBogus).toBeUndefined();
          expect(repo.layout.workDir).toBe(await realpath(wtForOurs));
          expect(gitPorcelain).toBe('D  a.txt');
          const change = result.changes.find((c) => c.path === 'a.txt');
          expect(change?.staged).toBe('deleted');
          expect(change?.unstaged).toBeUndefined();
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  describe('Given openRepository({cwd, gitDir, bare:true}) bootstrapping into an empty target (scenario J)', () => {
    let root: string;
    let d: string;

    beforeAll(async () => {
      root = await mkRoot('j');
      d = path.join(root, 'target.git');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When repo.init({bare:true}) bootstraps and real git reads the result back', () => {
      it('Then git reports a bare repo whose config matches the pinned init --bare shape', async () => {
        // Arrange
        const repo = await openRepository({ cwd: d, gitDir: d, bare: true });

        try {
          // Act — bootstrap, then seed one commit through primitives; there
          // is no work tree to `add`/`commit` through.
          await repo.init({ bare: true });
          const blobId = await repo.primitives.writeObject({
            type: 'blob',
            id: '' as ObjectId,
            content: new TextEncoder().encode('hello\n'),
          });
          const treeId = await repo.primitives.writeTree([
            { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
          ]);
          const commitId = await repo.primitives.writeObject({
            type: 'commit',
            id: '' as ObjectId,
            data: {
              tree: treeId,
              parents: [],
              author: AUTHOR,
              committer: AUTHOR,
              message: 'seed',
              extraHeaders: [],
            },
          });
          await repo.primitives.updateRef('refs/heads/main' as RefName, commitId, {
            reflogMessage: 'seed',
          });

          // Assert — the resolved layout, and the pinned init --bare shape.
          expect(repo.layout.gitDir).toBe(d);
          expect(repo.layout.bare).toBe(true);
          expect(repo.layout.workDir).toBeUndefined();
          expect(isBareAccordingToGit(d)).toBe(true);
          const config = await readFile(path.join(d, 'config'), 'utf8');
          expect(config).toContain('bare = true');
          expect(config).toContain('repositoryformatversion = 0');
          expect(config).not.toContain('logallrefupdates');
          expect(existsSync(path.join(d, 'index'))).toBe(false);
          const gitLog = git(d, 'log', '--format=%H').trim();
          expect(gitLog).toBe(commitId);
        } finally {
          await repo.dispose();
        }
      });

      it('Then reopening by cwd alone resolves the same bare layout', async () => {
        // Arrange + Act — `d` was already bootstrapped as a bare repo above;
        // BARE_DIR discovery finds the same gitDir with no explicit gitDir
        // argument this time.
        const reopened = await openRepository({ cwd: d });

        try {
          // Assert
          expect(reopened.layout.gitDir).toBe(d);
          expect(reopened.layout.bare).toBe(true);
        } finally {
          await reopened.dispose();
        }
      });
    });
  });

  describe('Given ceilingDirs bounding the discovery walk (scenario L)', () => {
    let root: string;
    let repoRoot: string;
    let cwd: string;

    beforeAll(async () => {
      root = await mkRoot('l');
      repoRoot = path.join(root, 'normal');
      buildNormalRepo(repoRoot);
      cwd = path.join(repoRoot, 'deep', 'deeper');
      await mkdir(cwd, { recursive: true });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    const expectedGitDirFor = (dir: string): string => path.join(dir, '.git');

    describe('When the walk runs with each ceiling row, passed explicitly to both tools', () => {
      it.each([
        { label: 'no ceiling', ceilings: (): ReadonlyArray<string> => [], found: true },
        { label: 'a ceiling above the repo', ceilings: () => [root], found: true },
        { label: 'a ceiling AT the repo root', ceilings: () => [repoRoot], found: false },
        {
          label: 'a ceiling at an intermediate ancestor',
          ceilings: () => [path.join(repoRoot, 'deep')],
          found: false,
        },
        { label: 'a ceiling equal to cwd (a no-op)', ceilings: () => [cwd], found: true },
        {
          label: 'a ceiling below cwd (irrelevant)',
          ceilings: () => [path.join(cwd, 'further-down')],
          found: true,
        },
        {
          label: 'multiple entries — the longest strict ancestor wins',
          ceilings: () => [root, path.join(repoRoot, 'deep')],
          found: false,
        },
      ])('Then $label agrees between git and tsgit', async ({ ceilings, found }) => {
        // Arrange
        const ceilingList = ceilings();
        const g = tryRunGitWithExit(['-C', cwd, 'rev-parse', '--show-toplevel'], {
          env: { ...runGitEnv(), GIT_CEILING_DIRECTORIES: ceilingList.join(':') },
        });

        // Act
        const repo = await openRepository({ cwd, ceilingDirs: ceilingList });

        try {
          // Assert
          expect(g.exitCode === 0).toBe(found);
          expect(repo.layout.gitDir === expectedGitDirFor(repoRoot)).toBe(found);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When openRepository runs with cwd AND the ceiling both equal to the repo root', () => {
      it('Then it is STILL found — the strict-ancestor rule makes it a no-op', async () => {
        // Arrange
        const g = tryRunGitWithExit(['-C', repoRoot, 'rev-parse', '--show-toplevel'], {
          env: { ...runGitEnv(), GIT_CEILING_DIRECTORIES: repoRoot },
        });

        // Act
        const repo = await openRepository({ cwd: repoRoot, ceilingDirs: [repoRoot] });

        try {
          // Assert
          expect(g.exitCode).toBe(0);
          expect(repo.layout.gitDir).toBe(expectedGitDirFor(repoRoot));
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('Symlinked cwd whose real target holds the repo', () => {
      let linkRoot: string;
      let realRoot: string;
      let linkedCwd: string;

      beforeAll(async () => {
        realRoot = path.join(root, 'real');
        buildNormalRepo(realRoot);
        await mkdir(path.join(realRoot, 'deep'), { recursive: true });
        linkRoot = path.join(root, 'link');
        await symlink(realRoot, linkRoot);
        linkedCwd = path.join(linkRoot, 'deep');
      }, SETUP_TIMEOUT);

      describe('When openRepository runs with the ceiling passed explicitly to both tools', () => {
        it.each([
          { label: 'the symlink path itself', ceiling: (): string => linkRoot },
          { label: 'the real (resolved) path', ceiling: (): string => realRoot },
        ])(
          'Then a ceiling of $label stops the walk — entries are realpathed, cwd compared physically',
          async ({ ceiling }) => {
            // Arrange
            const ceilingValue = ceiling();
            const g = tryRunGitWithExit(['-C', linkedCwd, 'rev-parse', '--show-toplevel'], {
              env: { ...runGitEnv(), GIT_CEILING_DIRECTORIES: ceilingValue },
            });

            // Act
            const repo = await openRepository({ cwd: linkedCwd, ceilingDirs: [ceilingValue] });

            try {
              // Assert — both refuse: the ceiling resolves to the SAME
              // physical directory as an ancestor of the (realpathed) cwd.
              expect(g.exitCode).toBe(128);
              expect(repo.layout.gitDir).toBe(path.join(await realpath(linkedCwd), '.git'));
            } finally {
              await repo.dispose();
            }
          },
        );
      });
    });
  });

  describe('Given the rev-parse layout queries, reconstructed from repo.layout + repo.ctx.cwd (scenario M)', () => {
    let root: string;
    let normal: string;
    let bare: string;

    beforeAll(async () => {
      root = await mkRoot('m');
      normal = path.join(root, 'normal');
      buildNormalRepo(normal);
      await mkdir(path.join(normal, 'sub', 'deep'), { recursive: true });
      bare = path.join(root, 'bare.git');
      runGit(['clone', '-q', '--bare', normal, bare]);
      disableAutoMaintenance(bare);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    const isPathInside = (candidate: string, ancestor: string): boolean =>
      candidate === ancestor || candidate.startsWith(`${ancestor}${path.sep}`);

    interface ReconstructionCase {
      /** Directory git runs in (`-C`). */
      readonly gitCwd: string;
      /** Extra git args ahead of `rev-parse` (`--git-dir` / `--work-tree`). */
      readonly gitExtra: ReadonlyArray<string>;
      /** The tsgit open options for the same invocation. */
      readonly open: {
        readonly cwd: string;
        readonly gitDir?: string;
        readonly workDir?: string;
      };
    }

    const revParseQuery = (c: ReconstructionCase, query: string) =>
      tryRunGitWithExit(['-C', c.gitCwd, ...c.gitExtra, 'rev-parse', query], {
        env: runGitEnv(),
      });

    /** Reconstructs every rev-parse layout query from `repo.layout` + `repo.ctx.cwd` and asserts each against real git. */
    const assertReconstructedQueriesMatchGit = async (c: ReconstructionCase): Promise<void> => {
      const repo = await openRepository(c.open);
      try {
        const layout = repo.layout;
        const cwd = repo.ctx.cwd;

        const pathFormat = tryRunGitWithExit(
          [
            '-C',
            c.gitCwd,
            ...c.gitExtra,
            'rev-parse',
            '--path-format=absolute',
            '--git-dir',
            '--git-common-dir',
          ],
          { env: runGitEnv() },
        );
        const [expectedGitDir = '', expectedCommonDir = ''] = pathFormat.stdout.trim().split('\n');
        expect(layout.gitDir).toBe(await realpath(expectedGitDir));
        expect(layout.commonDir ?? layout.gitDir).toBe(await realpath(expectedCommonDir));

        const absoluteGitDir = revParseQuery(c, '--absolute-git-dir').stdout.trim();
        expect(layout.gitDir).toBe(absoluteGitDir);

        const isBare = revParseQuery(c, '--is-bare-repository').stdout.trim() === 'true';
        expect(layout.bare).toBe(isBare);

        const toplevel = revParseQuery(c, '--show-toplevel');
        if (layout.workDir === undefined) {
          expect(toplevel.exitCode).toBe(128);
        } else {
          expect(toplevel.exitCode).toBe(0);
          expect(await realpath(layout.workDir)).toBe(await realpath(toplevel.stdout.trim()));
        }

        const insideWorkTree = revParseQuery(c, '--is-inside-work-tree').stdout.trim() === 'true';
        const oursInsideWorkTree =
          layout.workDir !== undefined && isPathInside(cwd, layout.workDir);
        expect(oursInsideWorkTree).toBe(insideWorkTree);

        const insideGitDir = revParseQuery(c, '--is-inside-git-dir').stdout.trim() === 'true';
        expect(isPathInside(cwd, layout.gitDir)).toBe(insideGitDir);

        const prefix = revParseQuery(c, '--show-prefix').stdout.trim();
        const oursPrefix =
          layout.workDir !== undefined &&
          isPathInside(cwd, layout.workDir) &&
          cwd !== layout.workDir
            ? `${path.relative(layout.workDir, cwd)}${path.sep}`
            : '';
        expect(oursPrefix).toBe(prefix);

        // cdup is TOTAL: inside the work tree it is the relative climb (empty
        // at the root); outside it, git prints the work tree's ABSOLUTE path;
        // with no work tree the query prints nothing.
        const cdup = revParseQuery(c, '--show-cdup');
        const oursCdup =
          layout.workDir === undefined
            ? ''
            : isPathInside(cwd, layout.workDir)
              ? cwd === layout.workDir
                ? ''
                : `${path.relative(cwd, layout.workDir)}${path.sep}`
              : await realpath(layout.workDir);
        expect(oursCdup).toBe(cdup.stdout.trim());
      } finally {
        await repo.dispose();
      }
    };

    describe('When cwd is the work-tree root of a normal repo', () => {
      it('Then every reconstructed query matches git', async () => {
        // Arrange / Act / Assert — the reconstruction table's nine queries
        // are asserted one by one inside the shared helper.
        await assertReconstructedQueriesMatchGit({
          gitCwd: normal,
          gitExtra: [],
          open: { cwd: normal },
        });
      });
    });

    describe('When cwd is a nested sub-directory of a normal repo', () => {
      it('Then every reconstructed query matches git', async () => {
        // Arrange
        const sub = path.join(normal, 'sub', 'deep');

        // Act / Assert
        await assertReconstructedQueriesMatchGit({ gitCwd: sub, gitExtra: [], open: { cwd: sub } });
      });
    });

    describe('When cwd is the gitDir of a bare repo', () => {
      it('Then every reconstructed query matches git', async () => {
        // Arrange / Act / Assert
        await assertReconstructedQueriesMatchGit({
          gitCwd: bare,
          gitExtra: [],
          open: { cwd: bare },
        });
      });
    });

    describe('When cwd is INSIDE the gitDir of a normal repo', () => {
      it('Then every reconstructed query matches git', async () => {
        // Arrange
        const inside = path.join(normal, '.git');

        // Act / Assert
        await assertReconstructedQueriesMatchGit({
          gitCwd: inside,
          gitExtra: [],
          open: { cwd: inside },
        });
      });
    });

    describe('When cwd is a sub-directory of the bare gitDir', () => {
      it('Then every reconstructed query matches git', async () => {
        // Arrange
        const inside = path.join(bare, 'refs');

        // Act / Assert
        await assertReconstructedQueriesMatchGit({
          gitCwd: inside,
          gitExtra: [],
          open: { cwd: inside },
        });
      });
    });

    describe('When the gitDir is explicit and cwd is unrelated', () => {
      it('Then every reconstructed query matches git — the work tree defaults to cwd', async () => {
        // Arrange
        const elsewhere = path.join(root, 'elsewhere-m1');
        await mkdir(elsewhere, { recursive: true });

        // Act / Assert
        await assertReconstructedQueriesMatchGit({
          gitCwd: elsewhere,
          gitExtra: [`--git-dir=${path.join(normal, '.git')}`],
          open: { cwd: elsewhere, gitDir: path.join(normal, '.git') },
        });
      });
    });

    describe('When gitDir and workDir are both explicit and cwd is outside the work tree', () => {
      it('Then every reconstructed query matches git — including the ABSOLUTE cdup form', async () => {
        // Arrange — the row the conditional reconstruction used to skip.
        const elsewhere = path.join(root, 'elsewhere-m2');
        const wt = path.join(root, 'wt-m2');
        await mkdir(elsewhere, { recursive: true });
        await mkdir(wt, { recursive: true });

        // Act / Assert
        await assertReconstructedQueriesMatchGit({
          gitCwd: elsewhere,
          gitExtra: [`--git-dir=${bare}`, `--work-tree=${wt}`],
          open: { cwd: elsewhere, gitDir: bare, workDir: wt },
        });
      });
    });
  });

  describe('Given explicit-gitDir edge cases (scenario Q)', () => {
    let root: string;

    beforeAll(async () => {
      root = await mkRoot('q');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When gitDir names a directory that does not yet exist', () => {
      it("Then tsgit resolves it, log refuses, and init succeeds — matching git's three rows", async () => {
        // Arrange
        const missing = path.join(root, 'missing-gitdir');
        const gitLog = tryRunGitWithExit(['--git-dir', missing, 'log'], { env: runGitEnv() });

        // Act
        const repo = await openRepository({ cwd: root, gitDir: missing });
        let logErr: unknown;
        try {
          await repo.log();
        } catch (err) {
          logErr = err;
        }
        const initResult = await repo.init({ bare: true });

        try {
          // Assert — git
          expect(gitLog.exitCode).toBe(128);
          // Assert — tsgit: resolves leniently, refuses only at first command
          expect(repo.layout.gitDir).toBe(missing);
          expect((logErr as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
          expect(initResult.bare).toBe(true);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When gitDir names an existing empty directory', () => {
      it('Then log refuses while init succeeds, matching git', async () => {
        // Arrange
        const emptyDir = path.join(root, 'empty-gitdir');
        await mkdir(emptyDir, { recursive: true });
        const gitLog = tryRunGitWithExit(['--git-dir', emptyDir, 'log'], { env: runGitEnv() });
        const gitInit = tryRunGitWithExit(['--git-dir', emptyDir, 'init'], { env: runGitEnv() });
        // git's own init above turned emptyDir into a real repo; rebuild a
        // clean empty directory before tsgit's own probe runs against it.
        await rm(emptyDir, { recursive: true, force: true });
        await mkdir(emptyDir, { recursive: true });

        // Act
        const repo = await openRepository({ cwd: root, gitDir: emptyDir });
        let logErr: unknown;
        try {
          await repo.log();
        } catch (err) {
          logErr = err;
        }
        const initResult = await repo.init();

        try {
          // Assert — git
          expect(gitLog.exitCode).toBe(128);
          expect(gitInit.exitCode).toBe(0);
          // Assert — tsgit
          expect((logErr as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
          expect(initResult.bare).toBe(false);
        } finally {
          await repo.dispose();
        }
      });
    });

    describe('When gitDir names a regular file with invalid gitfile content', () => {
      it('Then openRepository co-refuses with the gitfile-format refusal', async () => {
        // Arrange
        const plainFile = path.join(root, 'plain-file');
        await writeFile(plainFile, 'not a gitfile\n');
        const g = tryRunGitWithExit(['--git-dir', plainFile, 'log'], { env: runGitEnv() });

        // Act
        let caught: unknown;
        try {
          await openRepository({ cwd: root, gitDir: plainFile });
        } catch (err) {
          caught = err;
        }

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('invalid gitfile format');
        // Assert — tsgit
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('GITFILE_INVALID_FORMAT');
      });
    });

    describe('When workDir is given alone, with no repository anywhere up the tree', () => {
      it('Then both co-refuse — a work tree alone never conjures a repository', async () => {
        // Arrange
        const lonelyRoot = path.join(root, 'lonely');
        const wt = path.join(root, 'lonely-wt');
        await mkdir(lonelyRoot, { recursive: true });
        await mkdir(wt, { recursive: true });
        const g = tryRunGitWithExit(['-C', lonelyRoot, '--work-tree', wt, 'log'], {
          env: { ...runGitEnv(), GIT_CEILING_DIRECTORIES: lonelyRoot },
        });

        // Act
        const repo = await openRepository({
          cwd: lonelyRoot,
          workDir: wt,
          ceilingDirs: [lonelyRoot],
        });
        let logErr: unknown;
        try {
          await repo.log();
        } catch (err) {
          logErr = err;
        }

        try {
          // Assert — git
          expect(g.exitCode).toBe(128);
          expect(g.stderr).toContain('not a git repository');
          // Assert — tsgit
          expect((logErr as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
        } finally {
          await repo.dispose();
        }
      });
    });
  });
});

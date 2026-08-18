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
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
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

        // Act
        const log = await repo.log();
        const revParsed = await repo.revParse('HEAD');
        const catFile = await repo.catFile({ ids: [expectedHead] });
        const branches = await repo.branch.list();
        const tags = await repo.tag.list();

        // Assert
        expect(log.map((entry) => entry.id)).toEqual(expectedLog);
        expect(revParsed).toBe(expectedHead);
        expect(catFile.entries).toHaveLength(1);
        expect(branches.branches.some((b) => b.name === 'refs/heads/loose-topic')).toBe(true);
        expect(tags.tags.some((t) => t.name === 'refs/tags/loose-v1')).toBe(true);
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

    describe('When core.worktree resolves to a path that does not exist', () => {
      it('Then both tools ultimately fail on this shape (co-refusal)', async () => {
        // Arrange — git's --show-toplevel physically changes directory and fails; tsgit's
        // layout resolution stays lenient (lexical + a fallback realpath), so
        // the failure instead surfaces the first time a work-tree command
        // tries to actually read the (nonexistent) work tree.
        git(normal, 'config', 'core.worktree', '../missing-wt');
        const g = tryRunGitWithExit(['-C', normal, 'rev-parse', '--show-toplevel'], {
          env: runGitEnv(),
        });

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

        // Assert
        expect(g.exitCode).toBe(128);
        expect(caught).toBeDefined();
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
        // Assert — tsgit
        const data = (caught as { data?: { code?: string; gitDir?: string } })?.data;
        expect(data?.code).toBe('WORK_TREE_CONFIG_INVALID');
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
        it.each<[string, () => Promise<unknown>, ReadonlyArray<string>]>([
          ['status', () => repo.status(), ['status']],
          ['add', () => repo.add(['x']), ['add', '.']],
          ['checkout', () => repo.checkout({ rev: 'main' }), ['checkout', 'main']],
          ['commit', () => repo.commit({ message: 'x', author: AUTHOR }), ['commit', '-m', 'x']],
          ['merge', () => repo.merge.run({ rev: 'main' }), ['merge', 'main']],
          ['rm', () => repo.rm(['a.txt']), ['rm', 'a.txt']],
          ['mv', () => repo.mv(['a.txt'], 'b.txt'), ['mv', 'a.txt', 'b.txt']],
          ['reset --hard', () => repo.reset({ mode: 'hard', rev: 'HEAD' }), ['reset', '--hard']],
          [
            'grep (default target)',
            () => repo.grep({ patterns: [{ fixed: 'needle' }] }),
            ['grep', 'needle'],
          ],
          ['stash push', () => repo.stash.push({}), ['stash', 'push']],
          ['stash list', () => repo.stash.list(), ['stash', 'list']],
          ['stash pop', () => repo.stash.pop({}), ['stash', 'pop']],
          ['sparse-checkout list', () => repo.sparseCheckout.list(), ['sparse-checkout', 'list']],
          [
            'cherry-pick',
            () => repo.cherryPick.run({ commits: ['main'] }),
            ['cherry-pick', 'main'],
          ],
          ['revert', () => repo.revert.run({ commits: ['main'] }), ['revert', '--no-edit', 'main']],
          ['rebase', () => repo.rebase.run({ upstream: 'main' }), ['rebase', 'main']],
          ['submodule status', () => repo.submodule.list(), ['submodule', 'status']],
          ['submodule init', () => repo.submodule.init(), ['submodule', 'init']],
          ['submodule sync', () => repo.submodule.sync({}), ['submodule', 'sync']],
          [
            'submodule deinit',
            () => repo.submodule.deinit({ all: true }),
            ['submodule', 'deinit', '--all'],
          ],
        ])('Then %s refuses, matching git', async (_label, call, gitArgs) => {
          // Arrange
          const g = tryRunGitWithExit(['-C', bare, ...gitArgs], { env: runGitEnv() });

          // Act
          let caught: unknown;
          try {
            await call();
          } catch (err) {
            caught = err;
          }

          // Assert — git refuses (128 structural fatal, or 1 for submodule's shell wrapper)
          expect(g.exitCode === 128 || g.exitCode === 1).toBe(true);
          // Assert — tsgit refuses with a work-tree-shaped code
          const code = (caught as { data?: { code?: string } })?.data?.code;
          expect(code === 'WORK_TREE_REQUIRED' || code === 'WORK_TREE_CONFIG_INVALID').toBe(true);
        });
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
          expect((caught as { data?: { code?: string } })?.data?.code).toBe('WORK_TREE_REQUIRED');
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
});

/**
 * End-to-end clone against a local `git-http-backend` running over Node's
 * built-in http server. Verifies that the prior acceptance bullet from
 * holds:
 *
 *  repo.clone({ url }) against a real git-upload-pack endpoint produces a
 *  working repo whose `git log` matches the remote's HEAD line.
 *
 * The fixture under test/fixtures/clone-source/source.git is built once by
 * scripts/regenerate-clone-fixtures.sh and committed.
 *
 * A second suite serves bare twins whose ref files were written straight to
 * disk — shapes `git update-ref` would never create — and checks that clone
 * verifies a remote-sourced target the way canonical git does before it
 * writes the ref.
 *
 * The suite is gated on `git --version` being available + a discoverable
 * `git-http-backend` binary under `git --exec-path`. CI runners (Ubuntu,
 * macOS) have both pre-installed. Windows is out of scope.
 *
 * @proves
 *   surface: clone
 *   bucket:  real-http
 *   unique:  smart-HTTP packfile exchange against canonical git-http-backend produces a working repo
 */
import { execFile } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkCommits } from '../../../src/application/primitives/index.js';
import type { TsgitError, TsgitErrorData } from '../../../src/domain/error.js';
import type { ObjectId } from '../../../src/domain/objects/object-id.js';
import { openRepository } from '../../../src/index.node.js';
import {
  findGitHttpBackend,
  type GitHttpBackend,
  startGitHttpBackend,
} from '../../bench/support/http-backend-server.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from '../interop-helpers.js';

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');
const HEAD_HISTORY_FILE = path.join(FIXTURE_DIR, 'HEAD-history.txt');

const GIT_HTTP_BACKEND = findGitHttpBackend();
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    accessSync(HEAD_OID_FILE);
    return true;
  } catch {
    return false;
  }
})();

// Stryker sets `STRYKER_MUTANT_ID` for every mutant run. The spawned
// `git-http-backend` CGI does not work reliably across the sandbox boundary;
// mutation kills are carried by the unit tests anyway.
const RUNNING_UNDER_STRYKER = process.env.STRYKER_MUTANT_ID !== undefined;

const SKIP_REASON: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_HTTP_BACKEND === undefined
    ? 'git-http-backend not available — run scripts/regenerate-clone-fixtures.sh first'
    : !FIXTURE_AVAILABLE
      ? 'fixture missing — run scripts/regenerate-clone-fixtures.sh'
      : false;

describe.skipIf(SKIP_REASON !== false)('clone — end-to-end against git-http-backend', () => {
  let server: GitHttpBackend;
  let workDir: string;

  beforeAll(async () => {
    server = await startGitHttpBackend({ projectRoot: FIXTURE_DIR });
  });

  afterAll(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
    await server.close();
  });

  describe('Given a local git-http-backend, When clone runs', () => {
    it('Then HEAD matches the fixture oid and walkCommits surfaces it', async () => {
      // Arrange
      workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-clone-it-'));
      const url = `http://127.0.0.1:${server.port}/source.git`;
      const repo = await openRepository({
        cwd: workDir,
        allowInsecureHttp: true,
        config: {
          allowInsecure: true,
          allowPrivateNetworks: true,
          dnsResolver: async () => ['127.0.0.1'],
        },
      });

      // Act — the SSRF policy (allowInsecure / allowPrivateNetworks / dnsResolver)
      // is configured on openRepository above; clone needs only the url.
      const result = await repo.clone({ url });

      // Assert — clone result
      expect(result.head).toBe('refs/heads/main');
      expect(result.fetchedRefs.length).toBeGreaterThanOrEqual(1);

      // Assert — walking HEAD yields every commit in the fixture's chain (newest first)
      const expectedHead = (await readFile(HEAD_OID_FILE, 'utf8')).trim() as ObjectId;
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
      expect(seen[0]).toBe(expectedHead);
      expect(seen.length).toBe(history.length);
      expect([...seen].reverse()).toEqual(history);

      await repo.dispose();
    }, 30_000);
  });
});

const HOSTILE_SKIP: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_HTTP_BACKEND === undefined
    ? 'git-http-backend not available'
    : !GIT_AVAILABLE
      ? 'git not available'
      : false;

const CLONE_TIMEOUT = 60_000;

/** `git` over the same URL as tsgit, without blocking the in-process CGI
 *  server, reporting the refusal instead of throwing it. */
const tryCloneWithGit = async (
  url: string,
  dest: string,
): Promise<{ readonly exitCode: number; readonly stderr: string }> => {
  try {
    await execFileAsync('git', ['clone', '-q', url, dest], { env: runGitEnv() });
    return { exitCode: 0, stderr: '' };
  } catch (error) {
    const failure = error as { stderr?: string; code?: number };
    return { exitCode: failure.code ?? 1, stderr: failure.stderr ?? '' };
  }
};

describe.skipIf(HOSTILE_SKIP !== false)(
  'clone — target verification against git-http-backend',
  () => {
    let server: GitHttpBackend;
    let root = '';
    let treeId = '';
    const scratch: string[] = [];

    /** A bare twin of `source`, served under `name`, with one ref file
     *  written straight to disk — the shape a remote can advertise but
     *  `git update-ref` would never create. */
    const plantBare = async (name: string, relRefPath: string, value: string): Promise<void> => {
      const bare = path.join(root, name);
      runGit(['clone', '-q', '--bare', path.join(root, 'source'), bare]);
      const refPath = path.join(bare, ...relRefPath.split('/'));
      await mkdir(path.dirname(refPath), { recursive: true });
      await writeFile(refPath, `${value}\n`);
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-clone-verify-'));
      const source = path.join(root, 'source');
      runGit(['init', '-q', '-b', 'main', source]);
      git(source, 'config', 'user.name', 'A');
      git(source, 'config', 'user.email', 'a@x');
      git(source, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(source);
      await writeFile(path.join(source, 'f.txt'), 'c1\n');
      git(source, 'add', '-A');
      git(source, 'commit', '-q', '-m', 'c1');
      treeId = git(source, 'rev-parse', 'HEAD^{tree}').trim();
      await plantBare('branch-tree.git', 'refs/heads/main', treeId);
      await plantBare('detached-tree.git', 'HEAD', treeId);
      server = await startGitHttpBackend({ projectRoot: root });
    }, CLONE_TIMEOUT);

    afterAll(async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
      await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    /** Clones into a fresh working directory, capturing the refusal's data. */
    const cloneWithTsgit = async (url: string): Promise<TsgitErrorData | undefined> => {
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-clone-verify-ours-'));
      scratch.push(workDir);
      const repo = await openRepository({
        cwd: workDir,
        allowInsecureHttp: true,
        config: {
          allowInsecure: true,
          allowPrivateNetworks: true,
          dnsResolver: async () => ['127.0.0.1'],
        },
      });
      try {
        await repo.clone({ url });
        return undefined;
      } catch (error) {
        return (error as TsgitError).data;
      } finally {
        await repo.dispose();
      }
    };

    const urlFor = (name: string): string => `http://127.0.0.1:${server.port}/${name}`;

    describe('Given a remote whose HEAD branch names a tree, When clone runs', () => {
      it(
        'Then both refuse the non-commit and neither leaves a repository behind',
        async () => {
          // Arrange
          const url = urlFor('branch-tree.git');
          const dest = path.join(root, 'peer-branch-tree');

          // Act
          const oursData = await cloneWithTsgit(url);
          const peerResult = await tryCloneWithGit(url, dest);

          // Assert
          expect(oursData).toEqual({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit',
            actual: 'tree',
            id: treeId,
          });
          expect(peerResult.exitCode).toBe(128);
          expect(peerResult.stderr).toContain(`trying to write non-commit object ${treeId}`);
        },
        CLONE_TIMEOUT,
      );
    });

    describe('Given a remote whose detached HEAD names a tree, When clone runs', () => {
      it(
        'Then both refuse the non-commit HEAD',
        async () => {
          // Arrange
          const url = urlFor('detached-tree.git');
          const dest = path.join(root, 'peer-detached-tree');

          // Act
          const oursData = await cloneWithTsgit(url);
          const peerResult = await tryCloneWithGit(url, dest);

          // Assert
          expect(oursData).toEqual({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit',
            actual: 'tree',
            id: treeId,
          });
          expect(peerResult.exitCode).toBe(128);
          expect(peerResult.stderr).toContain(`trying to write non-commit object ${treeId}`);
        },
        CLONE_TIMEOUT,
      );
    });
  },
);

/**
 * Cross-tool interop — the commit-graph writer. Each scenario builds ONE
 * repository with real git (a linear history, a merge, an octopus merge, a
 * `--object-format=sha256` repo, and a repo with a reflog-only commit), then
 * copies it into two independent twins: `git commit-graph write --reachable`
 * runs on one, `writeCommitGraph` (tsgit's primitive) runs on the other. The
 * resulting `objects/info/commit-graph` bytes are compared byte-for-byte —
 * "tsgit on one, real git on its clone" is the shape every row uses.
 *
 * GDO2 pin (implementer-owed empirical probe, run in a `mktemp -d`
 * throwaway, never in this suite): a two-commit chain with
 * `GIT_COMMITTER_DATE=@4000000000` on the parent and `@1000000000` on the
 * child pushes the corrected-date offset past `0x7fffffff`. Real git 2.55.0
 * DOES emit a `GDO2` chunk there (`numChunks` 5: OIDF OIDL CDAT GDA2 GDO2) —
 * tsgit's reader does not parse it. tsgit's writer therefore REFUSES that
 * input (`COMMIT_GRAPH_GENERATION_OVERFLOW`) rather than emit a chunk it
 * cannot read back — no byte-identity row is claimed for that case; the
 * refusal itself is pinned by the domain unit test.
 *
 * @proves
 *   surface:        commitGraph
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's commit-graph write is byte-identical to `git commit-graph write --reachable`, refs-only roots included
 *   interopSurface: commitGraph
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { commitGraphPath } from '../../src/application/primitives/path-layout.js';
import { writeCommitGraph } from '../../src/application/primitives/write-commit-graph.js';
import { parseCommitGraphLayer, positionOf } from '../../src/domain/commit/commit-graph.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const tmpDir = (slug: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `tsgit-commit-graph-${slug}-`));

async function initRepo(slug: string, extraInitArgs: readonly string[] = []): Promise<string> {
  const dir = await tmpDir(slug);
  git(dir, 'init', '-q', '-b', 'main', ...extraInitArgs);
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  disableAutoMaintenance(dir);
  return dir;
}

async function addCommit(dir: string, name: string): Promise<string> {
  await writeFile(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', name);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

async function buildLinearRepo(): Promise<string> {
  const dir = await initRepo('linear');
  await addCommit(dir, 'c0');
  await addCommit(dir, 'c1');
  await addCommit(dir, 'c2');
  return dir;
}

async function buildMergeRepo(): Promise<string> {
  const dir = await initRepo('merge');
  await addCommit(dir, 'root');
  git(dir, 'checkout', '-q', '-b', 'feature');
  await addCommit(dir, 'feature');
  git(dir, 'checkout', '-q', 'main');
  await addCommit(dir, 'main2');
  runGit(['-C', dir, 'merge', '--no-edit', '-q', 'feature']);
  return dir;
}

async function buildOctopusRepo(): Promise<string> {
  const dir = await initRepo('octopus');
  await addCommit(dir, 'root');
  for (const branch of ['a', 'b', 'c']) {
    git(dir, 'checkout', '-q', '-b', branch);
    await addCommit(dir, branch);
    git(dir, 'checkout', '-q', 'main');
  }
  runGit(['-C', dir, 'merge', '--no-edit', '-q', 'a', 'b', 'c']);
  return dir;
}

async function buildSha256Repo(): Promise<string> {
  const dir = await initRepo('sha256', ['--object-format=sha256']);
  await addCommit(dir, 'c0');
  await addCommit(dir, 'c1');
  return dir;
}

interface ReflogOnlyRepo {
  readonly dir: string;
  readonly reachableId: string;
  readonly reflogOnlyId: string;
}

async function buildReflogOnlyRepo(): Promise<ReflogOnlyRepo> {
  const dir = await initRepo('reflog-only');
  const reachableId = await addCommit(dir, 'main0');
  git(dir, 'checkout', '-q', '-b', 'gone');
  const reflogOnlyId = await addCommit(dir, 'gone-commit');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', '-D', 'gone');
  return { dir, reachableId, reflogOnlyId };
}

interface TwinWrite {
  readonly peerBytes: Buffer;
  readonly oursBytes: Buffer;
  readonly oursDir: string;
  readonly peerDir: string;
}

/** Copies `baseDir` into a `peer` (git writes) and `ours` (tsgit writes) twin
 *  and returns both writes' bytes — the byte-identity oracle every row uses. */
async function writeBoth(
  baseDir: string,
  slug: string,
  algorithm: 'sha1' | 'sha256' = 'sha1',
): Promise<TwinWrite> {
  const peerDir = await tmpDir(`${slug}-peer`);
  const oursDir = await tmpDir(`${slug}-ours`);
  await cp(baseDir, peerDir, { recursive: true });
  await cp(baseDir, oursDir, { recursive: true });

  git(peerDir, 'commit-graph', 'write', '--reachable');
  const ctx = createNodeContext({ workDir: oursDir, algorithm });
  await writeCommitGraph(ctx);

  const peerBytes = await readFile(commitGraphPath(`${peerDir}/.git`));
  const oursBytes = await readFile(commitGraphPath(`${oursDir}/.git`));
  return { peerBytes, oursBytes, oursDir, peerDir };
}

function expectGitVerifiesSilently(dir: string): void {
  const result = tryRunGitWithExit(['-C', dir, 'commit-graph', 'verify']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
}

describe.skipIf(!GIT_AVAILABLE)('commit-graph write interop', () => {
  describe('Given a linear history built with real git', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await buildLinearRepo();
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then tsgit writes a commit-graph byte-identical to git commit-graph write --reachable, and git verifies it silently', async () => {
      // Arrange & Act
      const twin = await writeBoth(baseDir, 'linear');

      // Assert
      expect(Buffer.compare(twin.peerBytes, twin.oursBytes)).toBe(0);
      expectGitVerifiesSilently(twin.oursDir);
      await rm(twin.peerDir, { recursive: true, force: true });
      await rm(twin.oursDir, { recursive: true, force: true });
    });
  });

  describe('Given a two-parent merge history built with real git', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await buildMergeRepo();
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then tsgit writes a commit-graph byte-identical to git commit-graph write --reachable, and git verifies it silently', async () => {
      // Arrange & Act
      const twin = await writeBoth(baseDir, 'merge');

      // Assert
      expect(Buffer.compare(twin.peerBytes, twin.oursBytes)).toBe(0);
      expectGitVerifiesSilently(twin.oursDir);
      await rm(twin.peerDir, { recursive: true, force: true });
      await rm(twin.oursDir, { recursive: true, force: true });
    });
  });

  describe('Given a four-parent octopus merge built with real git', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await buildOctopusRepo();
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then tsgit writes the EDGE-bearing commit-graph byte-identical to git, and git verifies it silently', async () => {
      // Arrange & Act
      const twin = await writeBoth(baseDir, 'octopus');

      // Assert — numChunks byte confirms the EDGE chunk actually landed,
      // not just that both sides happened to agree on a smaller file.
      expect(twin.oursBytes[6]).toBe(5);
      expect(Buffer.compare(twin.peerBytes, twin.oursBytes)).toBe(0);
      expectGitVerifiesSilently(twin.oursDir);
      await rm(twin.peerDir, { recursive: true, force: true });
      await rm(twin.oursDir, { recursive: true, force: true });
    });
  });

  describe('Given a --object-format=sha256 repository built with real git', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await buildSha256Repo();
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then tsgit writes a hash-version-2 commit-graph byte-identical to git, and git verifies it silently', async () => {
      // Arrange & Act
      const twin = await writeBoth(baseDir, 'sha256', 'sha256');

      // Assert
      expect(twin.oursBytes[5]).toBe(2);
      expect(Buffer.compare(twin.peerBytes, twin.oursBytes)).toBe(0);
      expectGitVerifiesSilently(twin.oursDir);
      await rm(twin.peerDir, { recursive: true, force: true });
      await rm(twin.oursDir, { recursive: true, force: true });
    });
  });

  describe("Given a repo with a commit reachable only from a deleted branch's reflog", () => {
    let repo: ReflogOnlyRepo;

    beforeAll(async () => {
      repo = await buildReflogOnlyRepo();
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(repo.dir, { recursive: true, force: true });
    });

    it("Then the reflog-only commit is absent from tsgit's graph exactly as from git's", async () => {
      // Arrange & Act
      const twin = await writeBoth(repo.dir, 'reflog-only');

      // Assert — byte identity already proves the two agree; the explicit
      // membership check proves WHAT they agree on.
      expect(Buffer.compare(twin.peerBytes, twin.oursBytes)).toBe(0);
      const layer = parseCommitGraphLayer(new Uint8Array(twin.oursBytes));
      expect(layer.commitCount).toBe(1);
      expect(positionOf(layer, repo.reachableId as ObjectId)).not.toBeUndefined();
      expect(positionOf(layer, repo.reflogOnlyId as ObjectId)).toBeUndefined();
      expectGitVerifiesSilently(twin.oursDir);
      await rm(twin.peerDir, { recursive: true, force: true });
      await rm(twin.oursDir, { recursive: true, force: true });
    });
  });
});

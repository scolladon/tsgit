/**
 * End-to-end partial clone against a local `git-http-backend`.
 *
 * Verifies backlog 17.4: `repo.clone({ url, filter: 'blob:none' })` produces a
 * partial clone (promisor config + `.promisor` sentinel, blobs omitted), and a
 * later blob read is transparently lazy-fetched from the promisor remote.
 *
 * The served repository is a *copy* of the committed `clone-source` fixture,
 * configured in `beforeAll` with `uploadpack.allowfilter` +
 * `uploadpack.allowanysha1inwant` — the committed fixture is never mutated.
 *
 * @proves
 *   surface: clone.partial
 *   bucket:  real-http
 *   unique:  blob:none partial clone configures the promisor and lazy-fetches blobs on demand
 */
import { execFileSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Commit, ObjectId } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';
import {
  findGitHttpBackend,
  type GitHttpBackend,
  startGitHttpBackend,
} from '../../bench/support/http-backend-server.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');

const GIT_HTTP_BACKEND = findGitHttpBackend();
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    return true;
  } catch {
    return false;
  }
})();

const RUNNING_UNDER_STRYKER = process.env.STRYKER_MUTANT_ID !== undefined;

const SKIP_REASON: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_HTTP_BACKEND === undefined
    ? 'git-http-backend not available — run scripts/regenerate-clone-fixtures.sh first'
    : !FIXTURE_AVAILABLE
      ? 'fixture missing — run scripts/regenerate-clone-fixtures.sh'
      : false;

const SSRF_CONFIG = {
  allowInsecure: true,
  allowPrivateNetworks: true,
  dnsResolver: async (): Promise<ReadonlyArray<string>> => ['127.0.0.1'],
};
const CLONE_GUARDS = {
  allowInsecure: true,
  allowPrivateNetworks: true,
  resolver: async (): Promise<ReadonlyArray<string>> => ['127.0.0.1'],
};

const countPacks = async (gitDir: string): Promise<number> => {
  const entries = await readdir(path.join(gitDir, 'objects', 'pack'));
  return entries.filter((name) => name.endsWith('.pack')).length;
};

describe.skipIf(SKIP_REASON !== false)(
  'partial clone — end-to-end against git-http-backend',
  () => {
    let server: GitHttpBackend;
    let serveRoot: string;
    const workDirs: string[] = [];

    beforeAll(async () => {
      // Serve a copy of the fixture configured for partial clone — the
      // committed fixture stays pristine.
      serveRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-serve-'));
      const copy = path.join(serveRoot, 'source.git');
      await cp(SOURCE_GIT, copy, { recursive: true });
      execFileSync('git', ['-C', copy, 'config', 'uploadpack.allowfilter', 'true']);
      execFileSync('git', ['-C', copy, 'config', 'uploadpack.allowanysha1inwant', 'true']);
      server = await startGitHttpBackend({ projectRoot: serveRoot });
    });

    afterAll(async () => {
      for (const dir of workDirs) {
        await rm(dir, { recursive: true, force: true });
      }
      await rm(serveRoot, { recursive: true, force: true });
      await server.close();
    });

    const cloneInto = async (
      workDir: string,
    ): Promise<Awaited<ReturnType<typeof openRepository>>> => {
      const repo = await openRepository({
        cwd: workDir,
        allowInsecureHttp: true,
        config: SSRF_CONFIG,
      });
      await repo.clone({
        url: `http://127.0.0.1:${server.port}/source.git`,
        filter: 'blob:none',
        ...CLONE_GUARDS,
      });
      return repo;
    };

    it('Given a blob:none clone, When config is inspected, Then the promisor block and .promisor sentinel exist', async () => {
      // Arrange
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-'));
      workDirs.push(workDir);

      // Act
      const repo = await cloneInto(workDir);

      // Assert — config records the promisor remote.
      const config = await readFile(path.join(workDir, '.git', 'config'), 'utf8');
      expect(config).toContain('repositoryformatversion = 1');
      expect(config).toContain('partialClone = origin');
      expect(config).toContain('promisor = true');
      expect(config).toContain('partialclonefilter = blob:none');
      // Assert — the received pack is marked promisor.
      const packEntries = await readdir(path.join(workDir, '.git', 'objects', 'pack'));
      expect(packEntries.some((name) => name.endsWith('.promisor'))).toBe(true);

      await repo.dispose();
    }, 30_000);

    it('Given a blob omitted by the filter, When readBlob is called, Then it is lazy-fetched from the promisor', async () => {
      // Arrange
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-'));
      workDirs.push(workDir);
      const repo = await cloneInto(workDir);
      const gitDir = path.join(workDir, '.git');

      // The HEAD commit + its trees are present; locate an omitted blob.
      const headOid = (await repo.primitives.resolveRef('HEAD')) as ObjectId;
      const head = await repo.primitives.readObject(headOid);
      if (head.type !== 'commit') throw new Error('expected HEAD to resolve to a commit');
      const treeId = (head as Commit).data.tree;
      let blobId: ObjectId | undefined;
      for await (const entry of repo.primitives.walkTree(treeId, { recursive: true })) {
        blobId = entry.id;
        break;
      }
      if (blobId === undefined) throw new Error('fixture has no blob entries');
      const packsBefore = await countPacks(gitDir);

      // Act — readBlob misses locally and lazy-fetches.
      const blob = await repo.primitives.readBlob(blobId);

      // Assert — the blob resolved, and a new (promisor) pack landed.
      expect(blob.type).toBe('blob');
      expect(await countPacks(gitDir)).toBe(packsBefore + 1);

      // A second read is served locally — no further pack is written.
      await repo.primitives.readBlob(blobId);
      expect(await countPacks(gitDir)).toBe(packsBefore + 1);

      await repo.dispose();
    }, 30_000);

    it('Given several omitted blobs, When fetchMissing is called, Then they are pulled in one batch and git can read the repo', async () => {
      // Arrange
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-'));
      workDirs.push(workDir);
      const repo = await cloneInto(workDir);

      const headOid = (await repo.primitives.resolveRef('HEAD')) as ObjectId;
      const head = await repo.primitives.readObject(headOid);
      if (head.type !== 'commit') throw new Error('expected HEAD to resolve to a commit');
      const blobIds: ObjectId[] = [];
      for await (const entry of repo.primitives.walkTree((head as Commit).data.tree, {
        recursive: true,
      })) {
        blobIds.push(entry.id);
      }
      expect(blobIds.length).toBeGreaterThan(0);

      // Act
      const result = await repo.fetchMissing({ oids: blobIds });

      // Assert — every omitted blob was fetched in the batch.
      expect(result.remote).toBe('origin');
      expect(result.fetched).toBe(blobIds.length);
      // A second batch is a no-op now that the blobs are local.
      expect((await repo.fetchMissing({ oids: blobIds })).fetched).toBe(0);

      // Canonical git can read the lazy-filled partial clone.
      const log = execFileSync('git', ['-C', workDir, 'log', '--format=%H']).toString().trim();
      expect(log.split('\n').filter((line) => line.length === 40).length).toBeGreaterThanOrEqual(1);

      await repo.dispose();
    }, 30_000);
  },
);

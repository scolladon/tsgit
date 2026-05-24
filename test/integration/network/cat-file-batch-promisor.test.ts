/**
 * End-to-end check that `catFile` honors the partial-clone lazy-fetch:
 * an omitted blob is transparently pulled by the promisor remote on read.
 *
 * Mirrors `partial-clone-http-backend.test.ts`'s setup so the fixture and
 * SSRF guards stay aligned (backlog 17.6, ADRs 087–090).
 *
 * @proves
 *   surface: catFile.promisor
 *   bucket:  real-http
 *   unique:  catFile lazy-fetches omitted blobs from a real promisor remote
 */
import { execFileSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TsgitError } from '../../../src/domain/error.js';
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

describe.skipIf(SKIP_REASON !== false)('catFile — partial-clone lazy fetch', () => {
  let server: GitHttpBackend;
  let serveRoot: string;
  const workDirs: string[] = [];

  beforeAll(async () => {
    serveRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-cf-serve-'));
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

  const findOmittedBlob = async (
    repo: Awaited<ReturnType<typeof openRepository>>,
  ): Promise<ObjectId> => {
    const headOid = (await repo.primitives.resolveRef('HEAD')) as ObjectId;
    const head = await repo.primitives.readObject(headOid);
    if (head.type !== 'commit') throw new Error('expected HEAD to resolve to a commit');
    for await (const entry of repo.primitives.walkTree((head as Commit).data.tree, {
      recursive: true,
    })) {
      return entry.id;
    }
    throw new Error('fixture has no blob entries');
  };

  const countPacks = async (gitDir: string): Promise<number> => {
    const entries = await readdir(path.join(gitDir, 'objects', 'pack'));
    return entries.filter((name) => name.endsWith('.pack')).length;
  };

  it('Given a blob omitted by the filter, When catFile is called, Then it lazy-fetches and returns ok', async () => {
    // Arrange
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-cf-'));
    workDirs.push(workDir);
    const repo = await cloneInto(workDir);
    const gitDir = path.join(workDir, '.git');
    const blobOid = await findOmittedBlob(repo);
    const packsBefore = await countPacks(gitDir);

    // Act
    const result = await repo.catFile({ ids: [blobOid] });

    // Assert
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    if (entry?.ok !== true) throw new Error('expected ok');
    expect(entry.type).toBe('blob');
    // A new pack landed via the promisor.
    expect(await countPacks(gitDir)).toBe(packsBefore + 1);

    await repo.dispose();
  }, 30_000);

  it('Given an id the promisor errors on, When catFile is called, Then the wire-protocol error propagates (not swallowed as missing)', async () => {
    // Arrange — a fabricated oid the remote will refuse to serve. Per
    // ADR-088, only OBJECT_NOT_FOUND is a soft "missing"; network /
    // protocol errors propagate so the caller sees the real failure.
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-cf-'));
    workDirs.push(workDir);
    const repo = await cloneInto(workDir);
    const unknown = '1'.repeat(40) as ObjectId;

    // Act
    let caught: unknown;
    try {
      await repo.catFile({ ids: [unknown] });
    } catch (err) {
      caught = err;
    }

    // Assert — a TsgitError of a non-OBJECT_NOT_FOUND code propagates; the
    // result is NOT a soft `{ ok: false, reason: 'missing' }` entry.
    expect(caught).toBeInstanceOf(TsgitError);
    if (!(caught instanceof TsgitError)) throw caught;
    expect(caught.data.code).not.toBe('OBJECT_NOT_FOUND');

    await repo.dispose();
  }, 30_000);
});

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
 * The suite is gated on `git --version` being available + a discoverable
 * `git-http-backend` binary under `git --exec-path`. CI runners (Ubuntu,
 * macOS) have both pre-installed. Windows is out of scope.
 *
 * @proves
 *   surface: clone
 *   bucket:  real-http
 *   unique:  smart-HTTP packfile exchange against canonical git-http-backend produces a working repo
 */
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkCommits } from '../../../src/application/primitives/index.js';
import type { ObjectId } from '../../../src/domain/objects/object-id.js';
import { openRepository } from '../../../src/index.node.js';
import {
  findGitHttpBackend,
  type GitHttpBackend,
  startGitHttpBackend,
} from '../../bench/support/http-backend-server.js';

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

  it('Given a local git-http-backend, When clone runs, Then HEAD matches the fixture oid and walkCommits surfaces it', async () => {
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

    // Act
    const result = await repo.clone({
      url,
      allowInsecure: true,
      allowPrivateNetworks: true,
      resolver: async () => ['127.0.0.1'],
    });

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

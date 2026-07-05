/**
 * End-to-end partial clone (`--filter=blob:none`) against a local
 * `git-http-backend`, negotiated over protocol v2 (`Git-Protocol` forwarded
 * to the CGI). The sibling `partial-clone-http-backend.test.ts` never
 * exercises this leg — its server never advertises v2, so both tsgit and
 * real git stay on v1 there.
 *
 * Real git advertises `filter` as a sub-feature of the v2 `fetch` command
 * (`fetch=shallow wait-for-done filter`) rather than a top-level
 * ref-advertisement capability the way v1 does. This suite pins the fix that
 * folds it into the discovered advertisement's capabilities so a
 * v2-negotiating client still honours `--filter=blob:none` instead of
 * refusing.
 *
 * The served repository is a *copy* of the same committed `clone-source`
 * fixture the v1 suite uses, configured in `beforeAll` with
 * `uploadpack.allowfilter` + `uploadpack.allowanysha1inwant` — the committed
 * fixture is never mutated.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend` +
 * the committed fixture.
 *
 * @proves
 *   surface: clone.partial
 *   bucket:  real-http
 *   unique:  blob:none partial clone negotiates the v2 fetch=...filter sub-feature and matches real git's own v2 partial clone object set
 */
import { execFile } from 'node:child_process';
import { accessSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commit, ObjectId } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';
import {
  findGitHttpBackend,
  type GitHttpBackend,
  startGitHttpBackend,
} from '../../bench/support/http-backend-server.js';
import { runGit, runGitEnv, tryRunGit } from '../interop-helpers.js';

const execFileAsync = promisify(execFile);

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

// Stryker sets `STRYKER_MUTANT_ID` for every mutant run. The spawned
// `git-http-backend` CGI does not work reliably across the sandbox boundary;
// mutation kills are carried by the unit tests anyway.
const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');

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

/**
 * `cat-file --batch-all-objects` enumerates every object actually present
 * (loose + packed) — for a blob:none partial clone this is commits and trees
 * only, so comparing the sorted set between two independent clients is a
 * direct, filter-content-aware parity check, not just "clone succeeded".
 */
const localObjectSet = (dir: string): ReadonlyArray<string> =>
  runGit([
    '-C',
    dir,
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname) %(objecttype)',
  ])
    .trim()
    .split('\n')
    .sort();

describe.skipIf(SKIP_REASON !== false)(
  'partial clone over protocol v2 — end-to-end against git-http-backend',
  () => {
    let server: GitHttpBackend;
    let serveRoot: string;
    const dirs: string[] = [];

    beforeAll(async () => {
      // Serve a copy of the fixture configured for partial clone over v2 —
      // the committed fixture stays pristine.
      serveRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-v2-serve-'));
      const copy = path.join(serveRoot, 'source.git');
      await cp(SOURCE_GIT, copy, { recursive: true });
      runGit(['-C', copy, 'config', 'uploadpack.allowfilter', 'true']);
      runGit(['-C', copy, 'config', 'uploadpack.allowanysha1inwant', 'true']);
      server = await startGitHttpBackend({ projectRoot: serveRoot, forwardGitProtocol: true });
    });

    afterAll(async () => {
      for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
      }
      await rm(serveRoot, { recursive: true, force: true });
      await server.close();
    });

    it('Given a v2-negotiating server advertising filter as a fetch sub-feature, When tsgit clones with filter=blob:none, Then it configures the promisor remote, omits filtered blobs, and matches real git own v2 partial clone object set', async () => {
      // Arrange
      const url = `http://127.0.0.1:${server.port}/source.git`;
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-v2-'));
      const peerDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-pc-v2-peer-'));
      dirs.push(workDir, peerDir);
      const repo = await openRepository({
        cwd: workDir,
        allowInsecureHttp: true,
        config: SSRF_CONFIG,
      });

      // Act — clone over v2 with a blob filter; must not throw
      // REMOTE_FILTER_UNSUPPORTED now that `filter` is surfaced from the
      // v2 fetch command's sub-features.
      await repo.clone({ url, filter: 'blob:none', ...CLONE_GUARDS });

      // Assert — config records the promisor remote, the same fields the
      // v1 leg writes.
      const config = await readFile(path.join(workDir, '.git', 'config'), 'utf8');
      expect(config).toContain('partialClone = origin');
      expect(config).toContain('promisor = true');
      expect(config).toContain('partialclonefilter = blob:none');
      const packEntries = await readdir(path.join(workDir, '.git', 'objects', 'pack'));
      expect(packEntries.some((name) => name.endsWith('.promisor'))).toBe(true);

      // Assert — a blob reachable from HEAD's tree was not downloaded.
      const headOid = (await repo.primitives.resolveRef('HEAD')) as ObjectId;
      const head = await repo.primitives.readObject(headOid);
      if (head.type !== 'commit') throw new Error('expected HEAD to resolve to a commit');
      let blobId: ObjectId | undefined;
      for await (const entry of repo.primitives.walkTree((head as Commit).data.tree, {
        recursive: true,
      })) {
        blobId = entry.id;
        break;
      }
      if (blobId === undefined) throw new Error('fixture has no blob entries');
      // GIT_NO_LAZY_FETCH: a promisor repo makes `cat-file -e` on a missing
      // object lazily fetch it from the promisor remote — exactly the
      // transparency partial clone promises interactively, but it would mask
      // "was this blob actually filtered out?" behind a second network round
      // trip. Disable it so this checks local presence only.
      expect(
        tryRunGit(['-C', workDir, 'cat-file', '-e', blobId], {
          env: { ...runGitEnv(), GIT_NO_LAZY_FETCH: '1' },
        }).ok,
      ).toBe(false);
      await repo.dispose();

      // Assert — byte-identical to real git: an independent real-git clone
      // of the same URL, pinned to the same protocol version and filter,
      // downloads exactly the same object set and lands on the same HEAD.
      // `--bare` is required for a fair comparison — tsgit's clone never
      // materializes a working tree, but a non-bare real-git clone would
      // checkout HEAD and lazily re-fetch the exact blobs the filter just
      // excluded, which would confound this parity check with an unrelated
      // real-git checkout behaviour rather than the wire-level object set.
      // An async spawn is required — a synchronous one would block the
      // event loop the CGI response depends on, hanging forever.
      await execFileAsync(
        'git',
        [
          '-C',
          peerDir,
          '-c',
          'protocol.version=2',
          'clone',
          '-q',
          '--bare',
          '--filter=blob:none',
          url,
          '.',
        ],
        { env: runGitEnv() },
      );
      expect(localObjectSet(workDir)).toEqual(localObjectSet(peerDir));
      expect(runGit(['-C', workDir, 'rev-parse', 'HEAD']).trim()).toBe(
        runGit(['-C', peerDir, 'rev-parse', 'HEAD']).trim(),
      );
    }, 60_000);
  },
);

/**
 * End-to-end incremental fetch against a local `git-http-backend`, pinning
 * the whole feature: once a client has cloned a remote and that remote
 * advances, a subsequent `fetch` delivers exactly the missing commits —
 * byte-identical (same converged ref state) to what real git produces for
 * the same wire exchange. Run over both protocol legs the harness can now
 * drive: protocol v2 (`Git-Protocol` forwarded to the CGI) and the corrected
 * v1 fallback (forwarding withheld), via `startGitHttpBackend`'s
 * `forwardGitProtocol` toggle.
 *
 * The v2 leg also pins that clone checks out the tracked branch instead of
 * leaving HEAD detached — the ref advertisement's HEAD symref is now
 * surfaced as a v2 capability the same way it always was for v1.
 *
 * Suite is gated on `git --version` + a discoverable `git-http-backend`.
 *
 * @proves
 *   surface: fetch
 *   bucket:  real-http
 *   unique:  incremental fetch over protocol v2 and the v1 fallback delivers exactly the missing commits, matching real git
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { walkCommits } from '../../../src/application/primitives/index.js';
import type { ObjectId, RefName } from '../../../src/domain/objects/object-id.js';
import { openRepository } from '../../../src/index.node.js';
import {
  findGitHttpBackend,
  startGitHttpBackend,
} from '../../bench/support/http-backend-server.js';
import { git, runGitEnv } from '../interop-helpers.js';

const execFileAsync = promisify(execFile);

const GIT_HTTP_BACKEND = findGitHttpBackend();

// Stryker sets `STRYKER_MUTANT_ID` for every mutant run. The spawned
// `git-http-backend` CGI does not work reliably across the sandbox boundary;
// mutation kills are carried by the unit tests anyway.
const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');

const SKIP_REASON: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_HTTP_BACKEND === undefined
    ? 'git-http-backend not available on PATH'
    : false;

const AUTHOR_NAME = 'Ada';
const AUTHOR_EMAIL = 'ada@example.com';

interface BareSource {
  readonly parentDir: string;
  readonly bareDir: string;
  readonly seedDir: string;
}

const createBareSource = async (slug: string): Promise<BareSource> => {
  const parentDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-incremental-fetch-src-${slug}-`));
  const bareDir = path.join(parentDir, 'source.git');
  git(parentDir, 'init', '--bare', '-q', '-b', 'main', bareDir);
  const seedDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-incremental-fetch-seed-${slug}-`));
  git(seedDir, 'init', '-q', '-b', 'main');
  git(seedDir, 'config', 'user.name', AUTHOR_NAME);
  git(seedDir, 'config', 'user.email', AUTHOR_EMAIL);
  git(seedDir, 'remote', 'add', 'origin', bareDir);
  return { parentDir, bareDir, seedDir };
};

/** Write, commit, and push one file from the seed worktree — the real-git
 * "advance the remote" step, reused for both the initial commit (C0) and the
 * later advance (C1). Returns the new commit's oid, the golden the rest of
 * the scenario is pinned against.
 */
const commitAndPush = async (
  seedDir: string,
  filename: string,
  message: string,
): Promise<ObjectId> => {
  await writeFile(path.join(seedDir, filename), `${message}\n`);
  git(seedDir, 'add', filename);
  git(seedDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  git(seedDir, 'push', '-q', 'origin', 'main');
  return git(seedDir, 'rev-parse', 'HEAD').trim() as ObjectId;
};

/**
 * Clones over HTTP from a real, separate `git` process rather than the
 * synchronous `git()` helper: the served URL is this same test process's own
 * `startGitHttpBackend` instance, and a *synchronous* child-process spawn
 * would block the event loop the CGI response depends on, hanging forever
 * waiting for a response that can never be produced. An async spawn keeps
 * the event loop free to service the harness's own request handler.
 */
const cloneRealGitPeer = async (
  peerDir: string,
  url: string,
  protocolVersion: 0 | 2,
): Promise<string> => {
  await execFileAsync(
    'git',
    [
      '-C',
      peerDir,
      '-c',
      `protocol.version=${protocolVersion}`,
      '-c',
      'merge.conflictStyle=merge',
      'clone',
      '-q',
      url,
      '.',
    ],
    { env: runGitEnv() },
  );
  return git(peerDir, 'rev-parse', 'refs/heads/main').trim();
};

const reachableOids = async (
  ctx: Parameters<typeof walkCommits>[0],
  from: ObjectId,
): Promise<ObjectId[]> => {
  const seen: ObjectId[] = [];
  for await (const commit of walkCommits(ctx, { from: [from] })) {
    seen.push(commit.id);
  }
  return seen;
};

const runIncrementalFetchScenario = async (forwardGitProtocol: boolean): Promise<void> => {
  const slug = forwardGitProtocol ? 'v2' : 'v1';
  const protocolVersion = forwardGitProtocol ? 2 : 0;
  const source = await createBareSource(slug);
  const server = await startGitHttpBackend({ projectRoot: source.parentDir, forwardGitProtocol });
  const workDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-incremental-fetch-work-${slug}-`));
  const peerDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-incremental-fetch-peer-${slug}-`));
  try {
    const url = `http://127.0.0.1:${server.port}/source.git`;
    const c0 = await commitAndPush(source.seedDir, 'f0.txt', 'C0');

    const repo = await openRepository({
      cwd: workDir,
      allowInsecureHttp: true,
      config: {
        allowInsecure: true,
        allowPrivateNetworks: true,
        dnsResolver: async () => ['127.0.0.1'],
      },
    });
    const cloneResult = await repo.clone({ url });

    // Assert — clone reaches C0 and checks out the tracked branch (rather
    // than leaving HEAD detached); this is the fix pinned for the v2 leg.
    expect(cloneResult.head).toBe('refs/heads/main');
    const clonedMain = cloneResult.fetchedRefs.find(
      (r) => r.name === ('refs/heads/main' as RefName),
    );
    expect(clonedMain?.id).toBe(c0);

    // Act — the remote advances past what was cloned.
    const c1 = await commitAndPush(source.seedDir, 'f1.txt', 'C1');
    const sut = await repo.fetch({ remote: 'origin' });

    // Assert — fetch delivers exactly the new commit.
    const mainUpdate = sut.updatedRefs.find(
      (r) => r.name === ('refs/remotes/origin/main' as RefName),
    );
    expect(mainUpdate?.oldId).toBe(c0);
    expect(mainUpdate?.newId).toBe(c1);

    // Assert — byte-identical to real git: an independent real-git clone of
    // the same URL, pinned to the same protocol version, converges on the
    // identical oid over the identical transcript.
    const peerHead = await cloneRealGitPeer(peerDir, url, protocolVersion);
    expect(peerHead).toBe(c1);

    // Assert — the full C1→C0 history is materialised locally (pack
    // completeness), not just the ref pointer.
    const seen = await reachableOids(repo.ctx, c1);
    expect(seen).toEqual([c1, c0]);

    await repo.dispose();
  } finally {
    await server.close();
    await rm(source.parentDir, { recursive: true, force: true });
    await rm(source.seedDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(peerDir, { recursive: true, force: true });
  }
};

describe.skipIf(SKIP_REASON !== false)(
  'incremental fetch — end-to-end against git-http-backend',
  () => {
    describe('Given a remote that advances after clone, When tsgit fetches over protocol v2', () => {
      it('Then it delivers exactly the new commit and checks out the tracked branch, matching real git', async () => {
        await runIncrementalFetchScenario(true);
      }, 60_000);
    });

    describe('Given a remote that advances after clone, When tsgit fetches over the corrected v1 fallback', () => {
      it('Then it delivers exactly the new commit, matching real git', async () => {
        await runIncrementalFetchScenario(false);
      }, 60_000);
    });
  },
);

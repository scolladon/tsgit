/**
 * Cross-tool interop — submodule `add` / `update --init`. tsgit's clone is
 * smart-HTTP-only, so the submodule is served over a real `git-http-backend` for
 * tsgit; the canonical git reference uses a local `file://` clone (the harness's
 * in-process CGI helper does not speak real git's HTTP client). Both transports
 * fetch the **same** content-addressed objects from the committed `clone-source`
 * fixture, so the gitlink oid, absorbed layout (`core.worktree`, `.git` gitfile),
 * and checked-out worktree are asserted byte-identical to git's; the url-bearing
 * fields (which legitimately differ by transport) are unit-proven.
 *
 * The submodule remote is the committed `source.git` fixture (not built at
 * runtime), so `beforeAll` only boots the CGI server — matching the other
 * `*-http-backend` suites and staying robust under the full-suite concurrency.
 *
 * @proves
 *   surface:        submodule.add, submodule.update
 *   bucket:         cross-tool-interop
 *   unique:         tsgit submodule add/update reproduce git's absorbed layout + gitlink over smart-HTTP
 *   interopSurface: submodule
 */
import { execFileSync } from 'node:child_process';
import { accessSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openRepository } from '../../../src/index.node.js';
import {
  findGitHttpBackend,
  type GitHttpBackend,
  startGitHttpBackend,
} from '../../bench/support/http-backend-server.js';
import { runGitEnv } from '../interop-helpers.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');

// `runGitEnv()` scrubs every inherited `GIT_*` (notably `GIT_DIR`, which the
// husky pre-push hook exports) — without it, `git -C <tmp> commit` would commit
// to THIS repo's `.git` instead of the temp super, polluting the branch.
const ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', cwd, ...args], {
    env: ENV,
  }).toString();

const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    accessSync(HEAD_OID_FILE);
    return true;
  } catch {
    return false;
  }
})();
const SKIP =
  process.env.STRYKER_MUTANT_ID !== undefined ||
  findGitHttpBackend() === undefined ||
  !FIXTURE_AVAILABLE;

const openSuper = (cwd: string): ReturnType<typeof openRepository> =>
  openRepository({
    cwd,
    allowInsecureHttp: true,
    config: {
      allowInsecure: true,
      allowPrivateNetworks: true,
      dnsResolver: async () => ['127.0.0.1'],
    },
  });

const gitlinkLine = (dir: string): string =>
  git(dir, 'ls-files', '--stage')
    .split('\n')
    .find((l) => l.startsWith('160000')) ?? '';

const moduleWorktree = (dir: string): string =>
  git(dir, 'config', '-f', '.git/modules/lib/config', 'core.worktree').trim();

describe.skipIf(SKIP)('submodule add/update — interop over git-http-backend', () => {
  let server: GitHttpBackend;
  let root: string;
  let subUrl: string;
  const subHead = FIXTURE_AVAILABLE ? readFileSync(HEAD_OID_FILE, 'utf8').trim() : '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sub-it-'));
    server = await startGitHttpBackend({ projectRoot: FIXTURE_DIR });
    subUrl = `http://127.0.0.1:${server.port}/source.git`;
  }, 30_000);

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const initSuper = (dir: string): void => {
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: ENV });
    execFileSync('bash', ['-c', `echo root > "${dir}/README"`], { env: ENV });
    git(dir, 'add', 'README');
    git(dir, 'commit', '-qm', 'super c1');
  };

  it('Given two superprojects, When add runs (git file:// vs tsgit http), Then the absorbed layout + gitlink match', async () => {
    // Arrange
    const gitSuper = path.join(root, 'super-git');
    const tsSuper = path.join(root, 'super-ts');
    initSuper(gitSuper);
    initSuper(tsSuper);

    // Act — git over file://, tsgit over http (same objects either way)
    git(gitSuper, 'submodule', 'add', `file://${SOURCE_GIT}`, 'lib');
    const repo = await openSuper(tsSuper);
    const result = await repo.submodule.add({ url: subUrl, path: 'lib' });
    await repo.dispose();

    // Assert — transport-independent structure is byte-identical to git
    expect(result.id).toBe(subHead);
    expect(gitlinkLine(tsSuper)).toBe(gitlinkLine(gitSuper));
    expect(moduleWorktree(tsSuper)).toBe(moduleWorktree(gitSuper));
    expect(await readFile(path.join(tsSuper, 'lib', '.git'), 'utf8')).toBe(
      await readFile(path.join(gitSuper, 'lib', '.git'), 'utf8'),
    );
    // A fixture file was materialised into the submodule worktree, matching git
    expect(await readFile(path.join(tsSuper, 'lib', 'file-1.txt'), 'utf8')).toBe(
      await readFile(path.join(gitSuper, 'lib', 'file-1.txt'), 'utf8'),
    );
    // `.gitmodules` path line matches (the url line differs by transport, unit-proven)
    const gm = await readFile(path.join(tsSuper, '.gitmodules'), 'utf8');
    expect(gm).toContain('[submodule "lib"]\n\tpath = lib\n');
    expect(gm).toContain(`url = ${subUrl}`);
  }, 60_000);

  it("Given a committed gitlink, When tsgit update --init runs, Then it checks out git's pinned commit", async () => {
    // Arrange — a super pinning the submodule at `subHead` with an http url, built
    // without cloning over http (git's http client can't use the test CGI helper).
    const canon = path.join(root, 'canon');
    initSuper(canon);
    await writeFile(
      path.join(canon, '.gitmodules'),
      `[submodule "lib"]\n\tpath = lib\n\turl = ${subUrl}\n`,
    );
    git(canon, 'add', '.gitmodules');
    git(canon, 'update-index', '--add', '--cacheinfo', `160000,${subHead},lib`);
    git(canon, 'commit', '-qm', 'pin lib');
    const tsClone = path.join(root, 'clone-ts');
    git(root, 'clone', '-q', canon, tsClone);

    // Act — tsgit clones the submodule over http and checks out the pin
    const repo = await openSuper(tsClone);
    const result = await repo.submodule.update({ init: true });
    await repo.dispose();

    // Assert — detached HEAD at git's pinned oid, materialised worktree
    expect(result.entries[0]?.id).toBe(subHead);
    expect(git(tsClone, '-C', 'lib', 'rev-parse', 'HEAD').trim()).toBe(subHead);
    expect(
      (await readFile(path.join(tsClone, 'lib', 'file-1.txt'), 'utf8')).length,
    ).toBeGreaterThan(0);
    // name `lib` (one segment) ⇒ `.git/modules/lib` is three levels deep.
    expect(moduleWorktree(tsClone)).toBe('../../../lib');
  }, 60_000);
});

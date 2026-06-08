/**
 * Cross-tool interop — submodule `add` / `update --init`. tsgit's clone is
 * smart-HTTP-only, so the submodule is served over a real `git-http-backend` for
 * tsgit; the canonical git reference uses a local `file://` clone (the harness's
 * in-process CGI helper does not speak real git's HTTP client). The two transports
 * fetch the **same** content-addressed objects, so the gitlink oid, absorbed
 * layout (`core.worktree`, `.git` gitfile), and checked-out worktree are asserted
 * byte-identical to git's; the url-bearing fields (which legitimately differ by
 * transport) are unit-proven.
 *
 * @proves
 *   surface:        submodule.add, submodule.update
 *   bucket:         cross-tool-interop
 *   unique:         tsgit submodule add/update reproduce git's absorbed layout + gitlink over smart-HTTP
 *   interopSurface: submodule
 */
import { execFileSync } from 'node:child_process';
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

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
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

const GIT_HTTP_BACKEND = findGitHttpBackend();
const SKIP = process.env.STRYKER_MUTANT_ID !== undefined || GIT_HTTP_BACKEND === undefined;

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
  let subGitPath: string;
  let subUrl: string;
  let subHead: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sub-it-'));
    const subWork = path.join(root, 'sub');
    execFileSync('git', ['init', '-q', '-b', 'main', subWork], { env: ENV });
    await writeFile(path.join(subWork, 'lib.txt'), 'lib v1\n');
    git(subWork, 'add', 'lib.txt');
    git(subWork, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'sub c1');
    subGitPath = path.join(root, 'sub.git');
    execFileSync('git', ['clone', '-q', '--bare', subWork, subGitPath], { env: ENV });
    subHead = git(subGitPath, 'rev-parse', 'HEAD').trim();
    server = await startGitHttpBackend({ projectRoot: root });
    subUrl = `http://127.0.0.1:${server.port}/sub.git`;
  }, 30_000);

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const initSuper = (dir: string): void => {
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: ENV });
    execFileSync('bash', ['-c', `echo root > "${dir}/README"`], { env: ENV });
    git(dir, 'add', 'README');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'super c1');
  };

  it('Given two superprojects, When add runs (git file:// vs tsgit http), Then the absorbed layout + gitlink match', async () => {
    // Arrange
    const gitSuper = path.join(root, 'super-git');
    const tsSuper = path.join(root, 'super-ts');
    initSuper(gitSuper);
    initSuper(tsSuper);

    // Act — git over file://, tsgit over http (same objects either way)
    git(gitSuper, '-c', 'commit.gpgsign=false', 'submodule', 'add', `file://${subGitPath}`, 'lib');
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
    expect(await readFile(path.join(tsSuper, 'lib', 'lib.txt'), 'utf8')).toBe('lib v1\n');
    // `.gitmodules` path line matches (the url line differs by transport, unit-proven)
    const gm = await readFile(path.join(tsSuper, '.gitmodules'), 'utf8');
    expect(gm).toContain('[submodule "lib"]\n\tpath = lib\n');
    expect(gm).toContain(`url = ${subUrl}`);
  }, 30_000);

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
    git(canon, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'pin lib');
    const tsClone = path.join(root, 'clone-ts');
    git(root, 'clone', '-q', canon, tsClone);

    // Act — tsgit clones the submodule over http and checks out the pin
    const repo = await openSuper(tsClone);
    const result = await repo.submodule.update({ init: true });
    await repo.dispose();

    // Assert — detached HEAD at git's pinned oid, materialised worktree
    expect(result.entries[0]?.id).toBe(subHead);
    expect(git(tsClone, '-C', 'lib', 'rev-parse', 'HEAD').trim()).toBe(subHead);
    expect(await readFile(path.join(tsClone, 'lib', 'lib.txt'), 'utf8')).toBe('lib v1\n');
    // name `lib` (one segment) ⇒ `.git/modules/lib` is three levels deep.
    expect(moduleWorktree(tsClone)).toBe('../../../lib');
  }, 30_000);
});

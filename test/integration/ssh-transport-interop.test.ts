/**
 * Cross-tool ssh clone interop: real git and tsgit each clone the same bare
 * repo over the same fake ssh bridge, proving object-identity of the
 * resulting repositories (worktree content, index, HEAD commit, and the
 * `clone: from <url>` reflog subject).
 *
 * The bridge stands in for the ssh program (see ssh-transport.test.ts for
 * the full rationale): it ignores the host token and execs the quoted
 * remote command directly against the shared local bare repo, so both
 * tools drive the real git-upload-pack process through tsgit's ssh client
 * code path (real git) and tsgit's own (tsgit).
 */
import { accessSync, cpSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRef } from '../../src/application/primitives/index.js';
import type { RefName } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { lsStage, runGit, runGitEnv, topReflogSubject, writeTreeOf } from './interop-helpers.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const HEAD_OID_FILE = path.join(FIXTURE_DIR, 'HEAD-oid.txt');

const findGitExecPath = (): string | undefined => {
  try {
    return runGit(['--exec-path']).trim();
  } catch {
    return undefined;
  }
};

const GIT_EXEC_PATH = findGitExecPath();
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    accessSync(SOURCE_GIT);
    accessSync(HEAD_OID_FILE);
    return true;
  } catch {
    return false;
  }
})();

const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');

const SKIP_REASON: string | false = RUNNING_UNDER_STRYKER
  ? 'integration suite skipped under Stryker (mutation kills live in unit tests)'
  : GIT_EXEC_PATH === undefined
    ? 'git not available'
    : !FIXTURE_AVAILABLE
      ? 'fixture missing — run scripts/regenerate-clone-fixtures.sh'
      : false;

const installBridge = async (dir: string): Promise<string> => {
  const scriptPath = path.join(dir, 'ssh-bridge.sh');
  const execPathPrefix = GIT_EXEC_PATH !== undefined ? `${GIT_EXEC_PATH}:` : '';
  await writeFile(
    scriptPath,
    `#!/bin/sh\nPATH="${execPathPrefix}$PATH"\nexport PATH\nexec sh -c "$2"\n`,
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

describe.skipIf(SKIP_REASON !== false)(
  'ssh transport — cross-tool clone interop over the fake ssh bridge',
  () => {
    let bridgeDir: string;
    let bridgeScriptPath: string;
    let bareRoot: string;
    let bareRepoPath: string;
    let previousGitSshCommand: string | undefined;

    beforeAll(async () => {
      bridgeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-interop-bridge-'));
      bridgeScriptPath = await installBridge(bridgeDir);
      bareRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-interop-bare-'));
      bareRepoPath = path.join(bareRoot, 'source.git');
      cpSync(SOURCE_GIT, bareRepoPath, { recursive: true });
      // tsgit's ssh command resolution reads live process.env (NodeEnvReader),
      // unlike runGit's sanitised snapshot passed explicitly per-call below.
      previousGitSshCommand = process.env.GIT_SSH_COMMAND;
      process.env.GIT_SSH_COMMAND = bridgeScriptPath;
    });

    afterAll(async () => {
      if (previousGitSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousGitSshCommand;
      }
      await rm(bridgeDir, { recursive: true, force: true });
      await rm(bareRoot, { recursive: true, force: true });
    });

    describe('Given a bare repo served through the fake ssh bridge', () => {
      describe('When real git and tsgit each clone it over the same ssh:// URL', () => {
        it('Then both resulting repositories are object-identical', async () => {
          // Arrange
          const gitDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-interop-git-'));
          const tsgitDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-interop-tsgit-'));
          // No userinfo in the URL: real git's clone reflog message strips a
          // ssh:// URL's userinfo before recording it, which tsgit's clone
          // does not (out of scope for this transport work) — omitting the
          // user here keeps this assertion about the ssh session, not that
          // pre-existing, unrelated reflog-formatting divergence.
          const url = `ssh://localhost${bareRepoPath}`;
          const gitEnv = { ...runGitEnv(), GIT_SSH_COMMAND: bridgeScriptPath };

          try {
            // Act — real git clone, driven through the fake bridge.
            runGit(['clone', url, gitDir], { env: gitEnv });

            // Act — tsgit clone, driven through the same fake bridge.
            const repo = await openRepository({ cwd: tsgitDir });
            await repo.clone({ url });

            // Assert — identical `clone: from <url>` reflog subject, captured
            // before the explicit checkout below adds its own entry (real
            // git's clone folds its checkout into the same reflog entry;
            // tsgit's clone and checkout are separate composable commands).
            const gitReflogSubject = topReflogSubject(gitDir, 'HEAD');
            const tsgitReflogSubject = topReflogSubject(tsgitDir, 'HEAD');
            expect(tsgitReflogSubject).toBe(gitReflogSubject);
            expect(tsgitReflogSubject).toBe(`clone: from ${url}`);

            // Act — bring tsgit's side to working-tree parity: `clone` only
            // fetches objects and updates refs (Tier-1/Tier-2 composition —
            // checkout is a separate command), unlike real git's `clone`
            // which checks out the working tree as part of the same command.
            await repo.checkout({ rev: 'main' });

            // Assert — identical worktree content and index.
            expect(writeTreeOf(tsgitDir)).toBe(writeTreeOf(gitDir));
            expect(lsStage(tsgitDir)).toBe(lsStage(gitDir));

            // Assert — identical HEAD commit id.
            const gitHead = runGit(['-C', gitDir, 'rev-parse', 'HEAD'], { env: gitEnv }).trim();
            const tsgitHead = await resolveRef(repo.ctx, 'refs/heads/main' as RefName);
            expect(tsgitHead).toBe(gitHead);

            await repo.dispose();
          } finally {
            await rm(gitDir, { recursive: true, force: true });
            await rm(tsgitDir, { recursive: true, force: true });
          }
        }, 60_000);
      });
    });
  },
);

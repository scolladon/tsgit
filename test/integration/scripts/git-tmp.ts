/**
 * Shared helpers for integration tests that drive `git` inside a tmp directory.
 *
 * IMPORTANT: when these tests run from a git hook context (e.g. husky
 * pre-push), git sets `GIT_DIR`, `GIT_WORK_TREE`, and friends in the env.
 * git child processes inherit those vars and use them INSTEAD of falling back
 * to `cwd`. Without scrubbing, a `git init` + `git commit` cycle in a tmp
 * directory silently targets the HOST repo's `.git`, corrupting the user's
 * branch. ADR-103 documents the incident that motivated this helper.
 *
 * Always use `spawnGitInTmp` instead of calling `execFile('git', ...)` from
 * a `test/integration/scripts/` test.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_ENV_VARS_TO_SCRUB: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

export const cleanGitEnv = (extras: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extras };
  for (const key of GIT_ENV_VARS_TO_SCRUB) {
    delete env[key];
  }
  return env;
};

/**
 * Run git inside `dir` with all GIT_* env vars scrubbed. Throws (not silently
 * swallows) if git fails — caller usually wants the stdout for assertion.
 *
 * After the first `init` call, the caller MUST call `assertInitialised(dir)`
 * to catch the GIT_DIR-leak failure mode loudly. Otherwise the bug returns.
 */
export const spawnGitInTmp = async (
  dir: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> => {
  const { stdout } = await execFileAsync('git', args as string[], {
    cwd: dir,
    env: cleanGitEnv(extraEnv),
  });
  return stdout;
};

/**
 * Sanity check that `git init` actually targeted `dir`. Call this right after
 * `spawnGitInTmp(dir, ['init', '-q'])` in every test's `beforeEach`. If the
 * GIT_* scrubbing ever regresses, this fails immediately with a clear message
 * instead of silently corrupting the host repo.
 */
export const assertInitialised = (dir: string): void => {
  const gitDir = path.join(dir, '.git');
  if (!existsSync(gitDir)) {
    throw new Error(
      `git init did not create ${gitDir}. GIT_DIR may be leaking from the parent env — see test/integration/scripts/_git-tmp.ts.`,
    );
  }
};

/**
 * Helpers for write-surface interop tests. Each helper is small and
 * deliberately inlined-style so the test bodies still read top-down.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped). These
 * helpers spawn `git` and create on-disk tmpdirs, so they belong with
 * their integration peers.
 *
 * **Isolation discipline (the load-bearing piece).** Every `git`
 * invocation in this file goes through `runGit`, which spawns git with
 * **all `GIT_*` env vars stripped** from `process.env`. This is required
 * because:
 *
 *   1. When `npm run validate` runs from inside the husky pre-push hook,
 *      git invokes the hook with `GIT_DIR`, `GIT_WORK_TREE`,
 *      `GIT_INDEX_FILE`, etc. set in the environment (documented in
 *      `man githooks`).
 *   2. `npm → wireit → vitest → workers` all inherit that env.
 *   3. `git -C <tmp> <cmd>` only changes the CWD; `GIT_DIR` from env
 *      takes precedence over the repo at `<tmp>`, so `git -C tmp commit`
 *      silently lands on the worktree's `.git` instead of `tmp/.git`.
 *
 * The fix is to scrub `GIT_*` from the env we pass to spawned `git`.
 * `GIT_CEILING_DIRECTORIES` is added back as a defence-in-depth guard
 * against discovery-time walk-up when (rarely) `GIT_DIR` isn't set.
 *
 * **Ambient config isolation (same trap class, different vector).** Scrubbing
 * `GIT_*` is not enough: spawned `git` still inherits the developer's `HOME`
 * and so reads `~/.gitconfig` (global). Without `GIT_CONFIG_NOSYSTEM` it also
 * reads `/etc/gitconfig` (system), and it reads `$XDG_CONFIG_HOME/git/config`
 * (XDG) on a path discovered independently of `HOME`. Any of these silently
 * changes git's observable bytes from one machine to another (e.g. a global
 * `merge.conflictStyle=diff3` rewriting conflict markers, or a system
 * `credential.helper`) — the same flakiness class as the `GIT_DIR` leak above.
 * We point `HOME` (and the XDG root under it) at a deterministic NON-existent
 * path inside `os.tmpdir()` and set `GIT_CONFIG_NOSYSTEM=1`: git's lookups miss
 * and it fails soft to "no config". The path is never created — read/init/add/
 * commit (signing off) write nothing under `HOME` — so there is nothing to set
 * up and nothing to clean up.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Single source for the isolation HOME: a deterministic path under os.tmpdir()
// that is never created, so git's global/XDG config lookups miss and fail soft.
const ISOLATED_HOME = path.join(os.tmpdir(), 'tsgit-interop-nonexistent-home');

const buildSafeEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  env.HOME = ISOLATED_HOME;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.XDG_CONFIG_HOME = path.join(ISOLATED_HOME, '.config');
  return env;
};

const SAFE_ENV: NodeJS.ProcessEnv = buildSafeEnv();

/**
 * Spawn `git` with a sanitised env (no inherited `GIT_*` from the test
 * runner's parent). Use this for every git invocation in interop tests.
 *
 * For commit/tag operations that need deterministic author/committer
 * dates, spread `runGitEnv` and add the `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * vars in the call site's own env override.
 */
export const runGit = (
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string => {
  const env = options.env ?? SAFE_ENV;
  const opts: { env: NodeJS.ProcessEnv; input?: string } = { env };
  if (options.input !== undefined) opts.input = options.input;
  return execFileSync('git', args as string[], opts).toString();
};

/** Snapshot of the sanitised env, for tests that need to extend it. */
export const runGitEnv = (): NodeJS.ProcessEnv => ({ ...SAFE_ENV });

export const hasGit = (): boolean => {
  try {
    runGit(['--version']);
    return true;
  } catch {
    return false;
  }
};

export const GIT_AVAILABLE = hasGit();

export interface PeerPair {
  readonly peer: string;
  readonly ours: string;
  readonly dispose: () => Promise<void>;
}

export const makePeerPair = async (slug: string): Promise<PeerPair> => {
  const peer = await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-${slug}-peer-`));
  const ours = await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-${slug}-ours-`));
  const dispose = async (): Promise<void> => {
    await rm(peer, { recursive: true, force: true });
    await rm(ours, { recursive: true, force: true });
  };
  return { peer, ours, dispose };
};

export const initBothRepos = (peer: string, ours: string, branch = 'main'): void => {
  runGit(['init', '-q', '-b', branch, peer]);
  runGit(['init', '-q', '-b', branch, ours]);
  for (const dir of [peer, ours]) {
    runGit(['-C', dir, 'config', 'user.name', 'Ada']);
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  }
};

export const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args]);

/**
 * `git ls-files --stage` — the host-independent (mode sha stage\tpath)
 * listing. Stat-cache fields differ per host, so this readback (not raw
 * index bytes) is how two writers' indexes are compared.
 */
export const lsStage = (dir: string): string => git(dir, 'ls-files', '--stage');

/**
 * `git write-tree` — materialise the index to a tree id. Reads whichever
 * `.git/index` the directory holds (tsgit's or canonical git's), so equal
 * ids across two repos is the stat-independent state-equivalence proof.
 */
export const writeTreeOf = (dir: string): string => git(dir, 'write-tree').trim();

/**
 * Newest reflog subject (`%gs`) for `ref` — reads whichever `.git/logs` the
 * directory holds (tsgit's or canonical git's), so it doubles as a cross-tool
 * reflog-parity probe (`'refs/heads/main'` for the branch, `'HEAD'` for the
 * symref log-only path).
 */
export const topReflogSubject = (dir: string, ref: string): string =>
  git(dir, 'log', '-g', '--format=%gs', ref).split('\n')[0] ?? '';

export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `git` without throwing on a non-zero exit — for co-refusal assertions
 * (proving canonical git refuses exactly where tsgit does). Keeps the same
 * `SAFE_ENV` scrubbing as `runGit`; never shells through a string.
 */
export const tryRunGit = (
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): GitRunResult => {
  try {
    return { ok: true, stdout: runGit(args, options), stderr: '' };
  } catch (error) {
    const failure = error as {
      readonly stdout?: Buffer | string;
      readonly stderr?: Buffer | string;
    };
    return {
      ok: false,
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? '',
    };
  }
};

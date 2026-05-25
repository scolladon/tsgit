/**
 * Helpers for write-surface interop tests. Each helper is small and
 * deliberately inlined-style so the test bodies still read top-down.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped). These
 * helpers spawn `git` and create on-disk tmpdirs, so they belong with
 * their integration peers.
 *
 * **Isolation discipline.** Every `git` invocation in this file sets
 * `GIT_CEILING_DIRECTORIES=/tmp` so canonical git refuses to walk above
 * the tmpdir when it can't find a `.git` (e.g. if `git init` partially
 * failed under parallel-test load). Without this guard, `git -C <tmp>
 * commit` can silently land on the worktree's own `.git` if the
 * isolation chain breaks. Use the exported `runGit` helper for any
 * additional invocations in the interop tests themselves.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const SAFE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
};

export const runGit = (args: ReadonlyArray<string>, options: { input?: string } = {}): string => {
  const opts: { env: NodeJS.ProcessEnv; input?: string } = { env: SAFE_ENV };
  if (options.input !== undefined) opts.input = options.input;
  return execFileSync('git', args as string[], opts).toString();
};

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

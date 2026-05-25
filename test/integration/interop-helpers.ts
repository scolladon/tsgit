/**
 * Helpers for write-surface interop tests. Each helper is small and
 * deliberately inlined-style so the test bodies still read top-down.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped). These
 * helpers spawn `git` and create on-disk tmpdirs, so they belong with
 * their integration peers.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version']);
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
  execFileSync('git', ['init', '-q', '-b', branch, peer]);
  execFileSync('git', ['init', '-q', '-b', branch, ours]);
  // Identity for any commit operations
  for (const dir of [peer, ours]) {
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com']);
  }
};

export const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', ['-C', dir, ...args]).toString();

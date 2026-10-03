import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ObjectId } from '../../src/domain/objects/index.js';
import { git, runGit, runGitEnv } from './interop-helpers.js';

const SHARED_DATE = '1700000000 +0000';

const SHARED_DATE_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: SHARED_DATE,
  GIT_COMMITTER_DATE: SHARED_DATE,
};

export interface EqualDateHistory {
  readonly dir: string;
  readonly ids: Readonly<Record<'r' | 'a' | 'b' | 'c' | 'd' | 'n' | 'p', ObjectId>>;
  readonly dispose: () => Promise<void>;
}

/**
 * Every commit at ONE committer date, so git's order rests wholly on its
 * priority queue's tie-break: r ← {a, b, c, d}; n = merge(d, a);
 * p = merge(n, c, b) on `main`. `withCommitGraph` adds a reachable graph.
 */
export const buildEqualDateHistory = async (options: {
  readonly withCommitGraph: boolean;
}): Promise<EqualDateHistory> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-equal-date-')));
  runGit(['init', '-q', '-b', 'main', dir]);
  const tree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
  const commit = (message: string, parents: ReadonlyArray<ObjectId>): ObjectId => {
    const parentArgs = parents.flatMap((parent) => ['-p', parent]);
    const args = ['-C', dir, 'commit-tree', tree, ...parentArgs, '-m', message];
    return runGit(args, { env: SHARED_DATE_ENV }).trim() as ObjectId;
  };
  const r = commit('r', []);
  const a = commit('a', [r]);
  const b = commit('b', [r]);
  const c = commit('c', [r]);
  const d = commit('d', [r]);
  const n = commit('n', [d, a]);
  const p = commit('p', [n, c, b]);
  git(dir, 'update-ref', 'refs/heads/main', p);
  if (options.withCommitGraph) git(dir, 'commit-graph', 'write', '--reachable');
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, ids: { r, a, b, c, d, n, p }, dispose };
};

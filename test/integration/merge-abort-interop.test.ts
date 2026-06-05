/**
 * Cross-tool interop — `merge --abort` reflog faithfulness. A conflicted merge
 * never advances HEAD, so the abort resets to the (unchanged) tip: git records no
 * branch reflog entry (needs-commit no-move skip) and logs `reset: moving to HEAD`
 * on the coupled `HEAD` symref — the literal `HEAD`, not the oid, because
 * `merge --abort` delegates to a `reset` whose rev argument is `HEAD`. This pins
 * `repo.merge.abort` to that exact message + branch-skip against real `git`.
 *
 * @proves
 *   surface:        repo.merge.abort
 *   bucket:         cross-tool-interop
 *   unique:         merge --abort HEAD reflog message matches canonical git
 *   interopSurface: merge --abort
 */
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  topReflogSubject,
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const FIXED_DATE = '1700000000 +0000';

const configGit = (dir: string): void => {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message, '--author', 'Ada <ada@example.com>'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

/**
 * Build identical pinned history where `feature` and `main` both re-edit the same
 * line of `f.txt` off a shared `base`, so merging `feature` into `main` conflicts.
 */
const buildConflictingMerge = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'branch', 'feature');
  writeFileSync(path.join(dir, 'f.txt'), 'MAIN\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'on-main');
  git(dir, 'checkout', '-q', 'feature');
  writeFileSync(path.join(dir, 'f.txt'), 'FEATURE\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'on-feature');
  git(dir, 'checkout', '-q', 'main');
};

describe.skipIf(!GIT_AVAILABLE)('merge --abort reflog interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('merge-abort');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a conflicted merge aborted on both tools', () => {
    it('Then HEAD records `reset: moving to HEAD` and the branch reflog is unchanged', async () => {
      // Arrange — identical pinned conflicting-merge history in both repos.
      buildConflictingMerge(pair.peer);
      buildConflictingMerge(pair.ours);
      const peerBranchTop = topReflogSubject(pair.peer, 'refs/heads/main');
      const oursBranchTop = topReflogSubject(pair.ours, 'refs/heads/main');

      // Conflict on both tools (merge stops, HEAD unmoved).
      const peerMerge = tryRunGit(['-C', pair.peer, 'merge', 'feature']);
      expect(peerMerge.ok).toBe(false);
      const repo = await openRepository({ cwd: pair.ours });
      const oursMerge = await repo.merge.run({ rev: 'feature', author: AUTHOR });
      expect(oursMerge.kind).toBe('conflict');

      // Act — abort on both tools.
      runGit(['-C', pair.peer, 'merge', '--abort']);
      await repo.merge.abort();
      await repo.dispose();

      // Assert — identical faithful HEAD message, branch reflog left untouched.
      expect(topReflogSubject(pair.peer, 'HEAD')).toBe('reset: moving to HEAD');
      expect(topReflogSubject(pair.ours, 'HEAD')).toBe('reset: moving to HEAD');
      expect(topReflogSubject(pair.peer, 'refs/heads/main')).toBe(peerBranchTop);
      expect(topReflogSubject(pair.ours, 'refs/heads/main')).toBe(oursBranchTop);
    });
  });
});

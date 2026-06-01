/**
 * Cross-tool rebase interop. Pins tsgit's `repo.rebase` against real `git rebase`
 * (the merge backend):
 *   - clean rebase: resulting tree + preserved author + single-parent parity;
 *   - bidirectional resume — a tsgit-started rebase finished by `git rebase
 *     --continue`, and a git-started rebase finished by `repo.rebase.continue` —
 *     the proof of a byte-faithful, cross-tool-resumable `.git/rebase-merge/`;
 *   - abort reflog parity (HEAD `rebase (abort): returning to …`; branch untouched);
 *   - drop-set parity (both tools drop the same cherry-pick-equivalent commit).
 *
 * Commit OIDs embed the committer timestamp, so equivalence is asserted via the
 * host-independent tree readback (`git write-tree`) plus the preserved author
 * line, not raw oids. The source author date is pinned on both sides.
 *
 * @writes
 *   surface: rebase
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
  writeTreeOf,
} from './interop-helpers.js';

const FIXED_DATE = '1700000000 +0000';

const configGit = (dir: string): void => {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

const writeWork = (dir: string, rel: string, content: string): void => {
  writeFileSync(path.join(dir, rel), content);
};

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message, '--author', 'Ada <ada@example.com>'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

const headAuthor = (dir: string): string =>
  git(dir, 'cat-file', 'commit', 'HEAD')
    .split('\n')
    .find((l) => l.startsWith('author ')) ?? '';

const headParents = (dir: string): number =>
  git(dir, 'cat-file', 'commit', 'HEAD')
    .split('\n')
    .filter((l) => l.startsWith('parent ')).length;

const headHasBlob = (dir: string, rel: string): boolean =>
  git(dir, 'cat-file', '-t', git(dir, 'rev-parse', `HEAD:${rel}`).trim()).trim() === 'blob';

const commitCount = (dir: string): number => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());

describe.skipIf(!GIT_AVAILABLE)('rebase interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('rebase');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a topic diverged from an advanced main', () => {
    it('Then a clean rebase matches git: resulting tree, preserved author, single parent', async () => {
      // Arrange — identical history in both repos
      buildClean(pair.peer);
      buildClean(pair.ours);
      git(pair.peer, 'rebase', 'main');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      const result = await repo.rebase.run({ upstream: 'main' });
      await repo.dispose();

      // Assert
      expect(result.kind).toBe('rebased');
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      expect(headAuthor(pair.ours)).toBe(headAuthor(pair.peer));
      expect(headParents(pair.ours)).toBe(1);
      expect(headParents(pair.peer)).toBe(1);
    });
  });

  describe('Given a tsgit-started rebase that conflicts', () => {
    it('Then git rebase --continue finishes it (tsgit rebase-merge state is git-readable)', async () => {
      // Arrange — tsgit hits the conflict and persists `.git/rebase-merge/`
      const dir = pair.ours;
      buildConflict(dir);
      const repo = await openRepository({ cwd: dir });
      const stop = await repo.rebase.run({ upstream: 'main' });
      expect(stop.kind).toBe('conflict');
      await repo.dispose();

      // Resolve, then hand the rebase off to real git
      await writeFile(path.join(dir, 'f.txt'), 'l1\nRESOLVED\n');
      git(dir, 'add', 'f.txt');

      // Act
      runGit(['-C', dir, '-c', 'core.editor=true', 'rebase', '--continue']);

      // Assert — git committed the resolution; a.txt (the clean pick) survived
      expect(headHasBlob(dir, 'a.txt')).toBe(true);
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('topic');
    });
  });

  describe('Given a git-started rebase that conflicts', () => {
    it('Then repo.rebase.continue finishes it (tsgit reads git rebase-merge state)', async () => {
      // Arrange — git starts the rebase and stops on the conflict
      const dir = pair.ours;
      buildConflict(dir);
      tryRunGit(['-C', dir, '-c', 'core.editor=true', 'rebase', 'main']);

      // Resolve, then hand the git-written rebase-merge off to tsgit
      await writeFile(path.join(dir, 'f.txt'), 'l1\nRESOLVED\n');
      git(dir, 'add', 'f.txt');
      const repo = await openRepository({ cwd: dir });

      // Act
      const done = await repo.rebase.continue();
      await repo.dispose();

      // Assert
      expect(done.kind).toBe('rebased');
      expect(headHasBlob(dir, 'a.txt')).toBe(true);
    });
  });

  describe('Given a rebase aborted mid-conflict', () => {
    it('Then tsgit and git write the same faithful abort reflog, branch untouched', async () => {
      // Arrange — identical conflict in both; run each to the stop.
      buildConflict(pair.peer);
      buildConflict(pair.ours);
      const branchTop = topReflogSubject(pair.peer, 'refs/heads/topic');
      tryRunGit(['-C', pair.peer, '-c', 'core.editor=true', 'rebase', 'main']);
      const repo = await openRepository({ cwd: pair.ours });
      const stop = await repo.rebase.run({ upstream: 'main' });
      expect(stop.kind).toBe('conflict');

      // Act — abort on both tools
      runGit(['-C', pair.peer, 'rebase', '--abort']);
      await repo.rebase.abort();
      await repo.dispose();

      // Assert — HEAD records `rebase (abort): returning to refs/heads/topic`;
      // the branch never moved during the detached replay, so its reflog is unchanged.
      const peerHead = topReflogSubject(pair.peer, 'HEAD');
      expect(peerHead).toBe('rebase (abort): returning to refs/heads/topic');
      expect(topReflogSubject(pair.ours, 'HEAD')).toBe(peerHead);
      expect(topReflogSubject(pair.peer, 'refs/heads/topic')).toBe(branchTop);
      expect(topReflogSubject(pair.ours, 'refs/heads/topic')).toBe(branchTop);
    });
  });

  describe('Given a topic commit already present upstream', () => {
    it('Then tsgit and git drop the identical cherry-pick-equivalent commit', async () => {
      // Arrange — identical history where `dup` is patch-equivalent to a main commit
      buildCherryEquivalent(pair.peer);
      buildCherryEquivalent(pair.ours);
      git(pair.peer, 'rebase', 'main');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      const result = await repo.rebase.run({ upstream: 'main' });
      await repo.dispose();

      // Assert — both drop `dup`, leaving the same commit count and tree
      expect(result.kind).toBe('rebased');
      expect(commitCount(pair.ours)).toBe(commitCount(pair.peer));
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
    });
  });
});

// ── git-CLI scenario builders ───────────────────────────────────────────────

/** base; topic adds t1, t2; main advances with m1. HEAD left on topic. */
function buildClean(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'base.txt', 'base\n');
  git(dir, 'add', 'base.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeWork(dir, 't1.txt', 't1\n');
  git(dir, 'add', 't1.txt');
  gitCommit(dir, 't1 subject');
  writeWork(dir, 't2.txt', 't2\n');
  git(dir, 'add', 't2.txt');
  gitCommit(dir, 't2 subject');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'm1.txt', 'm1\n');
  git(dir, 'add', 'm1.txt');
  gitCommit(dir, 'm1');
  git(dir, 'checkout', '-q', 'topic');
}

/** topic: t1 adds a.txt (clean), t2 edits f.txt; main edits f.txt conflictingly. */
function buildConflict(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'l1\nl2\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeWork(dir, 'a.txt', 'a\n');
  git(dir, 'add', 'a.txt');
  gitCommit(dir, 't1 clean');
  writeWork(dir, 'f.txt', 'l1\nTOPIC\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 't2 conflict');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'f.txt', 'l1\nMAIN\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'm1 conflict');
  git(dir, 'checkout', '-q', 'topic');
}

/** topic: `dup` edits f a->b then t2 adds t.txt; main applies the same a->b then b->c. */
function buildCherryEquivalent(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'a\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'topic');
  writeWork(dir, 'f.txt', 'b\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'dup');
  writeWork(dir, 't.txt', 't\n');
  git(dir, 'add', 't.txt');
  gitCommit(dir, 't2');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'f.txt', 'b\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'dup on main');
  writeWork(dir, 'f.txt', 'c\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'm2 diverge');
  git(dir, 'checkout', '-q', 'topic');
}

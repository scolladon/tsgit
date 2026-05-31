/**
 * Cross-tool revert interop. Pins tsgit's `repo.revert` against real `git revert`:
 *   - clean single revert: resulting tree + the `Revert "…"` message (which embeds
 *     the reverted commit's oid) + single parent parity;
 *   - bidirectional sequencer resume — a tsgit-started multi-revert finished by
 *     `git revert --continue`, and a git-started multi-revert finished by
 *     `repo.revert.continue` — the proof of a git-byte-faithful, cross-tool-
 *     resumable `.git/sequencer/` (`revert <oid> <subject>` todo);
 *   - merge-commit co-refusal (both tools reject a no-mainline merge revert).
 *
 * The revert commit's own author/committer carry a live timestamp on the tsgit
 * side, so equivalence is asserted via the host-independent tree readback
 * (`git write-tree`), the message (whose embedded oid is deterministic because
 * the reverted history is pinned), and the parent count — not the revert commit's
 * raw oid. Signing is disabled on both sides.
 *
 * @writes
 *   surface: revert
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import { existsSync, writeFileSync } from 'node:fs';
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
  tryRunGit,
  writeTreeOf,
} from './interop-helpers.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

/** Fixed author + committer date so the reverted history (hence its oids) is identical across tools. */
const FIXED_DATE = '1700000000 +0000';

const configGit = (dir: string): void => {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

const writeWork = (dir: string, rel: string, content: string): void => {
  writeFileSync(path.join(dir, rel), content);
};

/** `git commit` with a pinned author + committer identity and date (deterministic oid). */
const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message, '--author', 'Ada <ada@example.com>'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

/** The revert commit's message + parent count (committer omitted: live timestamp). */
const commitShape = (dir: string): { message: string; parents: number } => {
  const raw = git(dir, 'cat-file', 'commit', 'HEAD');
  const lines = raw.split('\n');
  const parents = lines.filter((l) => l.startsWith('parent ')).length;
  const blank = lines.indexOf('');
  const message = lines.slice(blank + 1).join('\n');
  return { message, parents };
};

/** Whether a `.git/<file>` in-progress marker is present. */
const hasState = (dir: string, file: string): boolean => existsSync(path.join(dir, '.git', file));

/** Newest reflog subject for `main` — reads whichever `.git/logs` the dir holds (tsgit's or git's). */
const topReflog = (dir: string): string =>
  git(dir, 'log', '-g', '--format=%gs', 'refs/heads/main').split('\n')[0] ?? '';

/** Newest reflog subject for `HEAD` — the symref log-only path that records no-move resets. */
const topHeadReflog = (dir: string): string =>
  git(dir, 'log', '-g', '--format=%gs', 'HEAD').split('\n')[0] ?? '';

describe.skipIf(!GIT_AVAILABLE)('revert interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('revert');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given the tip commit reverted on main', () => {
    it('Then tsgit matches git: resulting tree, Revert message, single parent', async () => {
      // Arrange — identical pinned history in both repos.
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      configGit(pair.peer);
      writeWork(pair.peer, 'f.txt', 'v1\n');
      git(pair.peer, 'add', 'f.txt');
      gitCommit(pair.peer, 'base');
      writeWork(pair.peer, 'f.txt', 'v2\n');
      git(pair.peer, 'add', 'f.txt');
      gitCommit(pair.peer, 'change f');
      runGit(['-C', pair.peer, '-c', 'core.editor=true', 'revert', '--no-edit', 'HEAD']);

      const repo = await openRepository({ cwd: pair.ours });
      await repo.init();
      configGit(pair.ours);
      await writeFile(path.join(pair.ours, 'f.txt'), 'v1\n');
      await repo.add(['f.txt']);
      await repo.commit({ message: 'base', author: AUTHOR, committer: AUTHOR });
      await writeFile(path.join(pair.ours, 'f.txt'), 'v2\n');
      await repo.add(['f.txt']);
      await repo.commit({ message: 'change f', author: AUTHOR, committer: AUTHOR });

      // Act
      const result = await repo.revert.run({ commits: ['HEAD'] });

      // Assert
      expect(result.kind).toBe('reverted');
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      const ours = commitShape(pair.ours);
      const peer = commitShape(pair.peer);
      expect(ours.message).toBe(peer.message); // `Revert "change f"\n\nThis reverts commit <same oid>.`
      expect(ours.message.startsWith('Revert "change f"')).toBe(true);
      expect(ours.parents).toBe(1);
      expect(peer.parents).toBe(1);
      await repo.dispose();
    });
  });

  describe('Given a tsgit-started multi-revert conflict', () => {
    it('Then git revert --continue finishes it (tsgit sequencer is git-readable)', async () => {
      // Arrange — git builds the history; tsgit starts the multi-revert and stops.
      const dir = pair.ours;
      const { c2, c3 } = buildRevertConflictRange(dir);
      const repo = await openRepository({ cwd: dir });
      const stop = await repo.revert.run({ commits: [c3, c2] });
      expect(stop.kind).toBe('conflict');
      await repo.dispose();

      // Resolve, then hand the sequencer off to real git.
      await writeFile(path.join(dir, 'f.txt'), 'a\nB2\n');
      git(dir, 'add', 'f.txt');

      // Act
      runGit(['-C', dir, '-c', 'core.editor=true', 'revert', '--continue']);

      // Assert — git finished: no in-progress state remains.
      expect(hasState(dir, 'REVERT_HEAD')).toBe(false);
      expect(git(dir, 'rev-parse', 'HEAD:f.txt').trim().length).toBeGreaterThan(0);
    });
  });

  describe('Given a git-started multi-revert conflict', () => {
    it('Then repo.revert.continue finishes it (tsgit reads git abbreviated todo)', async () => {
      // Arrange — git starts the multi-revert and stops on the first conflict.
      const dir = pair.ours;
      const { c2, c3 } = buildRevertConflictRange(dir);
      tryRunGit(['-C', dir, '-c', 'core.editor=true', 'revert', c3, c2]);

      // Resolve, then hand the git-written sequencer off to tsgit.
      await writeFile(path.join(dir, 'f.txt'), 'a\nB2\n');
      git(dir, 'add', 'f.txt');
      const repo = await openRepository({ cwd: dir });

      // Act
      const done = await repo.revert.continue();

      // Assert
      expect(done.kind).toBe('reverted');
      expect(hasState(dir, 'REVERT_HEAD')).toBe(false);
      await repo.dispose();
    });
  });

  describe('Given a lone revert conflict aborted (no move)', () => {
    it('Then tsgit and git agree: branch reflog unchanged, HEAD records `reset: moving to`', async () => {
      // Arrange — reverting c3 alone conflicts (c4 re-touched line 1) and never
      // moves the branch; the seed is git-built + date-pinned on both repos.
      const { c3 } = buildRevertConflictRange(pair.peer);
      buildRevertConflictRange(pair.ours);
      const pre = git(pair.peer, 'rev-parse', 'refs/heads/main').trim();
      expect(git(pair.ours, 'rev-parse', 'refs/heads/main').trim()).toBe(pre);
      const branchTop = topReflog(pair.peer);
      tryRunGit(['-C', pair.peer, '-c', 'core.editor=true', 'revert', '--no-edit', c3]);
      const repo = await openRepository({ cwd: pair.ours });
      const stop = await repo.revert.run({ commits: [c3] });
      expect(stop.kind).toBe('conflict');

      // Act — abort on both tools; the branch stays at `pre` (no move)
      runGit(['-C', pair.peer, 'revert', '--abort']);
      await repo.revert.abort();
      await repo.dispose();

      // Assert — git writes no branch entry on a no-move, but logs HEAD; tsgit matches
      expect(topReflog(pair.peer)).toBe(branchTop);
      expect(topReflog(pair.ours)).toBe(branchTop);
      expect(topHeadReflog(pair.peer)).toBe(`reset: moving to ${pre}`);
      expect(topHeadReflog(pair.ours)).toBe(topHeadReflog(pair.peer));
    });
  });

  describe('Given a merge commit reverted with no mainline', () => {
    it('Then both git and tsgit refuse', async () => {
      // Arrange
      const dir = pair.ours;
      const mergeId = buildMergeRepo(dir);
      const peerRefusal = tryRunGit(['-C', dir, 'revert', mergeId]);
      const repo = await openRepository({ cwd: dir });

      // Act
      let oursCode: string | undefined;
      try {
        await repo.revert.run({ commits: [mergeId] });
      } catch (err) {
        oursCode = (err as { data?: { code?: string } }).data?.code;
      }

      // Assert
      expect(peerRefusal.ok).toBe(false);
      expect(oursCode).toBe('REVERT_MERGE_NO_MAINLINE');
      await repo.dispose();
    });
  });
});

// ── git-CLI scenario builders ───────────────────────────────────────────────

/**
 * Linear `main`: c1 base, c2 (line 2), c3 (line 1), c4 (line 1 again). Reverting
 * c3 conflicts (c4 re-touched line 1). Returns the c2 / c3 oids. HEAD left on c4.
 */
function buildRevertConflictRange(dir: string): { c2: string; c3: string } {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'a\nb\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'c1 base');
  writeWork(dir, 'f.txt', 'a\nB2\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'c2 line2');
  const c2 = git(dir, 'rev-parse', 'HEAD').trim();
  writeWork(dir, 'f.txt', 'A3\nB2\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'c3 line1');
  const c3 = git(dir, 'rev-parse', 'HEAD').trim();
  writeWork(dir, 'f.txt', 'A4\nB2\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'c4 line1 again');
  return { c2, c3 };
}

/** A repo whose `feature` tip is a merge commit; returns the merge oid. HEAD left on main. */
function buildMergeRepo(dir: string): string {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'base.txt', 'base\n');
  git(dir, 'add', 'base.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeWork(dir, 'f1.txt', 'f1\n');
  git(dir, 'add', 'f1.txt');
  gitCommit(dir, 'c1');
  git(dir, 'checkout', '-q', '-b', 'side', 'main');
  writeWork(dir, 's1.txt', 's1\n');
  git(dir, 'add', 's1.txt');
  gitCommit(dir, 's1');
  git(dir, 'checkout', '-q', 'feature');
  runGit(['-C', dir, '-c', 'core.editor=true', 'merge', '--no-ff', '-m', 'merge side', 'side']);
  const mergeId = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', 'main');
  return mergeId;
}

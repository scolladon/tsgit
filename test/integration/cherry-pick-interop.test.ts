/**
 * Cross-tool cherry-pick interop. Pins tsgit's `repo.cherryPick` against real
 * `git cherry-pick`:
 *   - clean single pick: resulting tree + preserved author + message + single
 *     parent parity;
 *   - bidirectional sequencer resume — a tsgit-started range finished by
 *     `git cherry-pick --continue`, and a git-started range finished by
 *     `repo.cherryPick.continue` — the proof of a git-byte-faithful,
 *     cross-tool-resumable `.git/sequencer/`;
 *   - merge-commit co-refusal (both tools reject a no-mainline merge pick);
 *   - abort reflog parity — a range that commits one pick then conflicts, aborted
 *     by both tools, writes the identical faithful `reset: moving to <oid>` entry.
 *
 * Commit OIDs embed the committer timestamp, so equivalence is asserted via the
 * host-independent tree readback (`git write-tree`) plus the preserved
 * author/message lines, not raw oids. The source author date is pinned on both
 * sides so the preserved author line is byte-comparable.
 *
 * @writes
 *   surface: cherryPick
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
  tryRunGit,
  writeTreeOf,
} from './interop-helpers.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

/** Fixed author/committer date so the preserved-author line is byte-comparable across tools. */
const FIXED_DATE = '1700000000 +0000';

/** Configure a git repo deterministically (identity + no signing). */
const configGit = (dir: string): void => {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

/** Write a working-tree file synchronously (no git env involved). */
const writeWork = (dir: string, rel: string, content: string): void => {
  writeFileSync(path.join(dir, rel), content);
};

/** `git commit` with a pinned author identity + date (deterministic author line). */
const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message, '--author', 'Ada <ada@example.com>'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

/** The preserved author line + message + parent count (committer omitted: live timestamp). */
const commitShape = (dir: string): { author: string; message: string; parents: number } => {
  const raw = git(dir, 'cat-file', 'commit', 'HEAD');
  const lines = raw.split('\n');
  const author = lines.find((l) => l.startsWith('author ')) ?? '';
  const parents = lines.filter((l) => l.startsWith('parent ')).length;
  const blank = lines.indexOf('');
  const message = lines.slice(blank + 1).join('\n');
  return { author, message, parents };
};

/** A blob path resolves in HEAD's tree — proof the pick that introduced it landed. */
const headHasBlob = (dir: string, rel: string): boolean =>
  git(dir, 'cat-file', '-t', git(dir, 'rev-parse', `HEAD:${rel}`).trim()).trim() === 'blob';

/** Newest reflog subject for `main` — reads whichever `.git/logs` the dir holds (tsgit's or git's). */
const topReflog = (dir: string): string =>
  git(dir, 'log', '-g', '--format=%gs', 'refs/heads/main').split('\n')[0] ?? '';

describe.skipIf(!GIT_AVAILABLE)('cherry-pick interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('cherry-pick');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a feature commit picked onto main', () => {
    it('Then tsgit matches git: resulting tree, preserved author, message, single parent', async () => {
      // Arrange — same history + same clean pick in both repos
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      configGit(pair.peer);
      writeWork(pair.peer, 'base.txt', 'base\n');
      git(pair.peer, 'add', 'base.txt');
      gitCommit(pair.peer, 'base');
      git(pair.peer, 'checkout', '-q', '-b', 'feature');
      writeWork(pair.peer, 'feat.txt', 'feat\n');
      git(pair.peer, 'add', 'feat.txt');
      gitCommit(pair.peer, 'feat subject\n\nbody');
      git(pair.peer, 'checkout', '-q', 'main');
      git(pair.peer, 'cherry-pick', 'feature');

      const repo = await openRepository({ cwd: pair.ours });
      await repo.init();
      configGit(pair.ours);
      await writeFile(path.join(pair.ours, 'base.txt'), 'base\n');
      await repo.add(['base.txt']);
      await repo.commit({ message: 'base', author: AUTHOR });
      await repo.branch.create({ name: 'feature' });
      await repo.checkout({ target: 'feature' });
      await writeFile(path.join(pair.ours, 'feat.txt'), 'feat\n');
      await repo.add(['feat.txt']);
      await repo.commit({ message: 'feat subject\n\nbody', author: AUTHOR });
      await repo.checkout({ target: 'main' });

      // Act
      const result = await repo.cherryPick.run({ commits: ['feature'] });

      // Assert
      expect(result.kind).toBe('picked');
      expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
      const ours = commitShape(pair.ours);
      const peer = commitShape(pair.peer);
      expect(ours.author).toBe(peer.author);
      expect(ours.message).toBe(peer.message);
      expect(ours.parents).toBe(1);
      expect(peer.parents).toBe(1);
      await repo.dispose();
    });
  });

  describe('Given a tsgit-started range conflict', () => {
    it('Then git cherry-pick --continue finishes it (tsgit sequencer is git-readable)', async () => {
      // Arrange — git builds a conflicting range; tsgit starts the pick and stops
      const dir = pair.ours;
      buildConflictRange(dir);
      const repo = await openRepository({ cwd: dir });
      const stop = await repo.cherryPick.run({ commits: ['main..feature'] });
      expect(stop.kind).toBe('conflict');
      await repo.dispose();

      // Resolve, then hand the sequencer off to real git
      await writeFile(path.join(dir, 'f.txt'), 'l1\nBOTH\n');
      git(dir, 'add', 'f.txt');

      // Act
      runGit(['-C', dir, '-c', 'core.editor=true', 'cherry-pick', '--continue']);

      // Assert — git committed the resolved pick and finished the remaining one
      expect(headHasBlob(dir, 'g.txt')).toBe(true);
    });
  });

  describe('Given a git-started range conflict', () => {
    it('Then repo.cherryPick.continue finishes it (tsgit reads git abbreviated todo)', async () => {
      // Arrange — git starts the range and stops on the first conflict
      const dir = pair.ours;
      buildConflictRange(dir);
      tryRunGit(['-C', dir, '-c', 'core.editor=true', 'cherry-pick', 'main..feature']);

      // Resolve, then hand the git-written sequencer off to tsgit
      await writeFile(path.join(dir, 'f.txt'), 'l1\nBOTH\n');
      git(dir, 'add', 'f.txt');
      const repo = await openRepository({ cwd: dir });

      // Act
      const done = await repo.cherryPick.continue();

      // Assert
      expect(done.kind).toBe('picked');
      expect(headHasBlob(dir, 'g.txt')).toBe(true);
      await repo.dispose();
    });
  });

  describe('Given a merge commit picked with no mainline', () => {
    it('Then both git and tsgit refuse', async () => {
      // Arrange
      const dir = pair.ours;
      const mergeId = buildMergeRepo(dir);
      const peerRefusal = tryRunGit(['-C', dir, 'cherry-pick', mergeId]);
      const repo = await openRepository({ cwd: dir });

      // Act
      let oursCode: string | undefined;
      try {
        await repo.cherryPick.run({ commits: [mergeId] });
      } catch (err) {
        oursCode = (err as { data?: { code?: string } }).data?.code;
      }

      // Assert
      expect(peerRefusal.ok).toBe(false);
      expect(oursCode).toBe('CHERRY_PICK_MERGE_NO_MAINLINE');
      await repo.dispose();
    });
  });

  describe('Given a range cherry-pick aborted mid-sequence', () => {
    it('Then tsgit and git write the same faithful `reset: moving to` reflog', async () => {
      // Arrange — identical moving range in both repos; run each to the conflict stop.
      // The seed is git-built + date-pinned on both, so the pre-sequence oid is shared.
      buildMovingConflictRange(pair.peer);
      buildMovingConflictRange(pair.ours);
      const pre = git(pair.peer, 'rev-parse', 'refs/heads/main').trim();
      expect(git(pair.ours, 'rev-parse', 'refs/heads/main').trim()).toBe(pre);
      tryRunGit(['-C', pair.peer, '-c', 'core.editor=true', 'cherry-pick', 'main..feature']);
      const repo = await openRepository({ cwd: pair.ours });
      const stop = await repo.cherryPick.run({ commits: ['main..feature'] });
      expect(stop.kind).toBe('conflict');

      // Act — abort on both tools (first pick committed, so the branch moves back)
      runGit(['-C', pair.peer, 'cherry-pick', '--abort']);
      await repo.cherryPick.abort();
      await repo.dispose();

      // Assert — git's literal format (oracle) + byte-identical tsgit parity
      expect(topReflog(pair.peer)).toBe(`reset: moving to ${pre}`);
      expect(topReflog(pair.ours)).toBe(topReflog(pair.peer));
    });
  });
});

// ── git-CLI scenario builders ───────────────────────────────────────────────

/** `main` + a `feature` branch whose first commit conflicts on f.txt; HEAD left on main. */
function buildConflictRange(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'l1\nl2\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeWork(dir, 'f.txt', 'l1\nFEAT\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'c1 change');
  writeWork(dir, 'g.txt', 'g\n');
  git(dir, 'add', 'g.txt');
  gitCommit(dir, 'c2 add g');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'f.txt', 'l1\nMAIN\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'main change');
}

/**
 * `main` + a `feature` branch whose first commit (a new file) picks cleanly and
 * whose second conflicts on f.txt; HEAD left on main. `main..feature` therefore
 * commits the clean pick (moving the branch) before stopping on the conflict —
 * so an abort genuinely resets the branch backward, exercising the reflog write.
 */
function buildMovingConflictRange(dir: string): void {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeWork(dir, 'f.txt', 'base\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeWork(dir, 'g.txt', 'g\n');
  git(dir, 'add', 'g.txt');
  gitCommit(dir, 'clean add g');
  writeWork(dir, 'f.txt', 'FEAT\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'conflict f');
  git(dir, 'checkout', '-q', 'main');
  writeWork(dir, 'f.txt', 'MAIN\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'main diverge');
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

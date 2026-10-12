/**
 * Cross-tool interop — git's `@{-<n>}` and lone `-` (the n-th prior checkout)
 * read by tsgit's revision resolver, `checkout` and `branch` against `git`,
 * over one HEAD reflog git wrote, plus the `checkout: moving from` reflog
 * label a detached HEAD leaves, which `@{-<n>}` reads back.
 *
 * @proves
 *   surface:        revParse, checkout, branch.delete
 *   bucket:         cross-tool-interop
 *   unique:         a prior checkout named @{-n} or - resolves, attaches and deletes the branch git does, and a detached prior is logged as its full object id
 *   interopSurface: revParse, reflog
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const FIXED_DATE = '1700000000 +0000';

/** A commit with pinned dates, so both repositories hold the same object ids. */
const commitEmpty = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', message], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

/** main and side diverged; HEAD went main → side → main. */
const build = (dir: string): void => {
  commitEmpty(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  commitEmpty(dir, 'side');
  git(dir, 'checkout', '-q', 'main');
  commitEmpty(dir, 'main');
};

const newestHeadSubject = (dir: string): string => git(dir, 'reflog', '-1', '--format=%gs').trim();

describe.skipIf(!GIT_AVAILABLE)('prior checkout interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('prior-checkout');
    initBothRepos(pair.peer, pair.ours);
    build(pair.peer);
    build(pair.ours);
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe.each(['@{-1}', '@{-1}~1', '@{-2}', '@{-1}@{0}'])(
    'Given a git-written HEAD reflog, When %s is resolved',
    (expression) => {
      it('Then tsgit names the object git does', async () => {
        // Arrange
        const repo = await openRepository({ cwd: pair.ours });

        // Act
        const result = await repo.revParse(expression);
        await repo.dispose();

        // Assert
        expect(result).toEqual([
          { kind: 'object', id: git(pair.ours, 'rev-parse', expression).trim(), negated: false },
        ]);
      });
    },
  );

  describe('Given a git-written HEAD reflog, When checkout -', () => {
    it('Then tsgit attaches to the branch git does and logs the same subject', async () => {
      // Arrange
      git(pair.peer, 'checkout', '-q', '-');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      await repo.checkout({ rev: '-' });
      await repo.dispose();

      // Assert
      expect(git(pair.ours, 'symbolic-ref', 'HEAD')).toBe(git(pair.peer, 'symbolic-ref', 'HEAD'));
      expect(newestHeadSubject(pair.ours)).toBe(newestHeadSubject(pair.peer));
    });
  });

  describe('Given a detached HEAD, When tsgit checks out a branch and then -', () => {
    it('Then the reflog labels match git and - detaches at the same commit', async () => {
      // Arrange
      for (const dir of [pair.peer, pair.ours]) git(dir, 'checkout', '-q', '--detach', 'side');
      git(pair.peer, 'checkout', '-q', 'main');
      git(pair.peer, 'checkout', '-q', '-');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      await repo.checkout({ rev: 'main' });
      const leaving = newestHeadSubject(pair.ours);
      await repo.checkout({ rev: '-' });
      await repo.dispose();

      // Assert
      expect(leaving).toBe(git(pair.peer, 'reflog', '-1', '--format=%gs', 'HEAD@{1}').trim());
      expect(newestHeadSubject(pair.ours)).toBe(newestHeadSubject(pair.peer));
      expect(git(pair.ours, 'rev-parse', 'HEAD')).toBe(git(pair.peer, 'rev-parse', 'HEAD'));
    });
  });

  describe('Given a git-written HEAD reflog, When branch -D @{-1}', () => {
    it('Then tsgit deletes the branch git does', async () => {
      // Arrange
      git(pair.peer, 'branch', '-q', '-D', '@{-1}');
      const repo = await openRepository({ cwd: pair.ours });

      // Act
      await repo.branch.delete({ name: '@{-1}', force: true });
      await repo.dispose();

      // Assert
      expect(git(pair.ours, 'branch', '--list')).toBe(git(pair.peer, 'branch', '--list'));
    });
  });
});

/**
 * Cross-tool interop — `worktree` add / list / move / remove. Builds a tsgit repo
 * with one commit, runs `repo.worktree.*`, and proves canonical git can read the
 * resulting on-disk state (`git -C <worktree> …` resolves tsgit's `.git` gitfile
 * → admin dir → commondir), with the admin bytes, branch ref + reflog, index, and
 * working tree matching. A canonical-git peer pins the cross-tool `add` /
 * dirty-`remove` refusals.
 *
 * @proves
 *   surface:        repo.worktree.add
 *   bucket:         cross-tool-interop
 *   unique:         worktree add/list/move/remove produce git-readable on-disk state
 *   interopSurface: worktree
 */
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
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

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

describe.skipIf(!GIT_AVAILABLE)('worktree interop', () => {
  let pair: PeerPair;
  let repo: Repository;
  // The realpath of the repo root — on macOS the tmpdir is symlinked
  // (/var → /private/var), and the node adapter confines by realpath, so the
  // worktree siblings must share the resolved prefix.
  let ours: string;
  const created: string[] = [];

  const sibling = (suffix: string): string => {
    const dir = `${ours}-${suffix}`;
    created.push(dir);
    return dir;
  };

  beforeEach(async () => {
    pair = await makePeerPair('worktree');
    ours = await realpath(pair.ours);
    repo = await openRepository({ cwd: ours });
    await repo.init();
    await writeFile(path.join(ours, 'a.txt'), 'hello\n');
    await repo.add(['a.txt']);
    await repo.commit({ message: 'seed commit', author: AUTHOR });
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
    for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const headOid = (): string => git(ours, 'rev-parse', 'HEAD').trim();

  describe('Given a repo with one commit', () => {
    describe('When worktree.add creates a new branch', () => {
      it('Then git reads the worktree and the admin bytes match', async () => {
        // Arrange
        const wt = sibling('wt');

        // Act
        const result = await repo.worktree.add({ path: wt, branch: 'wt' });

        // Assert — git resolves tsgit's gitfile → admin → commondir
        expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(headOid());
        expect(git(wt, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/wt');
        expect(git(wt, 'ls-files', '--stage').trim()).toBe(git(ours, 'ls-files', '--stage').trim());
        expect(await readFile(path.join(wt, 'a.txt'), 'utf8')).toBe('hello\n');
        // admin pointer bytes
        const admin = path.join(ours, '.git', 'worktrees', result.id);
        expect(await readFile(path.join(admin, 'HEAD'), 'utf8')).toBe('ref: refs/heads/wt\n');
        expect(await readFile(path.join(admin, 'commondir'), 'utf8')).toBe('../..\n');
        expect(await readFile(path.join(admin, 'gitdir'), 'utf8')).toBe(`${wt}/.git\n`);
        expect(await readFile(path.join(wt, '.git'), 'utf8')).toBe(`gitdir: ${admin}\n`);
        // branch ref + reflog
        expect(git(ours, 'rev-parse', 'refs/heads/wt').trim()).toBe(headOid());
        expect(topReflogSubject(ours, 'refs/heads/wt')).toBe('branch: Created from HEAD');
      });
    });

    describe('When worktree.add --detach', () => {
      it('Then git reads a detached HEAD at the commit', async () => {
        // Arrange
        const wt = sibling('det');

        // Act
        await repo.worktree.add({ path: wt, detach: true });

        // Assert
        expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(headOid());
        expect(tryRunGit(['-C', wt, 'symbolic-ref', 'HEAD']).ok).toBe(false);
      });
    });

    describe('When worktree.list', () => {
      it('Then git worktree list reads the same worktrees', async () => {
        // Arrange
        const wt = sibling('wt');
        await repo.worktree.add({ path: wt, branch: 'wt' });

        // Act
        const result = await repo.worktree.list();

        // Assert
        expect(result.entries.map((e) => e.branch)).toEqual(['refs/heads/main', 'refs/heads/wt']);
        const porcelain = git(ours, 'worktree', 'list', '--porcelain');
        expect(porcelain).toContain(`worktree ${wt}`);
        expect(porcelain).toContain('branch refs/heads/wt');
      });
    });

    describe('When worktree.move', () => {
      it('Then git reads the relocated worktree and the admin gitdir is re-pointed', async () => {
        // Arrange
        const wt = sibling('wt');
        const moved = sibling('moved');
        const { id } = await repo.worktree.add({ path: wt });

        // Act
        await repo.worktree.move(wt, moved);

        // Assert
        expect(git(moved, 'rev-parse', 'HEAD').trim()).toBe(headOid());
        const admin = path.join(ours, '.git', 'worktrees', id);
        expect(await readFile(path.join(admin, 'gitdir'), 'utf8')).toBe(`${moved}/.git\n`);
      });
    });

    describe('When worktree.remove on a clean worktree', () => {
      it('Then the worktree and admin dir are gone and the branch remains', async () => {
        // Arrange
        const wt = sibling('wt');
        const { id } = await repo.worktree.add({ path: wt, branch: 'wt' });

        // Act
        await repo.worktree.remove(wt);

        // Assert
        await expect(readFile(path.join(wt, 'a.txt'), 'utf8')).rejects.toThrow();
        const admin = path.join(ours, '.git', 'worktrees', id);
        await expect(readFile(path.join(admin, 'HEAD'), 'utf8')).rejects.toThrow();
        expect(git(ours, 'rev-parse', 'refs/heads/wt').trim()).toBe(headOid());
      });
    });

    describe('When worktree.remove on a dirty worktree', () => {
      it('Then tsgit and canonical git both refuse', async () => {
        // Arrange
        const wt = sibling('wt');
        await repo.worktree.add({ path: wt });
        await writeFile(path.join(wt, 'untracked.txt'), 'x');

        // Act
        const tsgitRefused = await repo.worktree
          .remove(wt)
          .then(() => false)
          .catch((err) => (err as { data?: { code?: string } }).data?.code === 'WORKTREE_DIRTY');

        // Assert
        expect(tsgitRefused).toBe(true);
        expect(tryRunGit(['-C', ours, 'worktree', 'remove', wt]).ok).toBe(false);
      });
    });
  });

  describe('Given a canonical-git peer', () => {
    describe('When add targets a branch already checked out', () => {
      it('Then both tools refuse', async () => {
        // Arrange — peer is a plain git repo with a checked-out branch
        runGit(['init', '-q', '-b', 'main', pair.peer]);
        await writeFile(path.join(pair.peer, 'a.txt'), 'hello\n');
        runGit(['-C', pair.peer, 'add', 'a.txt'], { env: COMMIT_ENV });
        runGit(['-C', pair.peer, 'commit', '-m', 'seed commit'], { env: COMMIT_ENV });
        const peerWt = `${pair.peer}-wt`;
        created.push(peerWt);

        // Act
        const gitRefused = !tryRunGit(['-C', pair.peer, 'worktree', 'add', peerWt, 'main']).ok;
        const tsgitRefused = await repo.worktree
          .add({ path: sibling('main-wt'), commitish: 'main' })
          .then(() => false)
          .catch(
            (err) => (err as { data?: { code?: string } }).data?.code === 'BRANCH_CHECKED_OUT',
          );

        // Assert
        expect(gitRefused).toBe(true);
        expect(tsgitRefused).toBe(true);
      });
    });
  });
});

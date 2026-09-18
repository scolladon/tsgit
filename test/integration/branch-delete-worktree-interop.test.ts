/**
 * Cross-tool interop — the two gates an unforced `branch.delete` must pass:
 * no worktree holds the branch, and its tip is already reachable from the
 * reference git measures against. Every row builds its own repository, runs
 * canonical git's `branch -d` as the oracle and tsgit's `branchDelete` as
 * the subject against a private twin of the same shape, and compares exit
 * code + the `error:` line git prints against the refusal data tsgit
 * throws. Covers the holder shapes git's `find_shared_symref` walks — the
 * current checkout, a linked worktree, a linked worktree whose directory is
 * gone but whose registration survives, the same registration once pruned,
 * a detached HEAD that names no branch at all, and a bare main checkout
 * that is skipped whether or not a linked worktree holds the branch — and
 * the references `branch_merged` consults: HEAD, a configured upstream that
 * replaces it in both directions, a squash that leaves content merged but
 * history unreachable, and a symbolic branch git never measures at all.
 *
 * @proves
 *   surface:        branch.delete
 *   bucket:         cross-tool-interop
 *   unique:         branch.delete refuses exactly the branches a worktree
 *                    holds or an unmerged tip carries, and force is the
 *                    only thing that overrides the second gate
 *   interopSurface: branch
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { branchDelete } from '../../src/application/commands/branch.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;

/** git's `error: cannot delete branch '<name>' used by worktree at '<path>'`. */
const heldLine = (branch: string, worktree: string): string =>
  `error: cannot delete branch '${branch}' used by worktree at '${worktree}'\n`;

/** git's unforced refusal, with `advice.forceDeleteBranch` off so the two
 *  hint lines it would otherwise append never enter the comparison. */
const unmergedLine = (branch: string): string =>
  `error: the branch '${branch}' is not fully merged\n`;

/** `branch -d` with git's delete advice silenced. */
const quietDelete = (dir: string, ...args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, '-c', 'advice.forceDeleteBranch=false', 'branch', ...args]);

/** A branch carrying one commit its start point never saw, left unchecked-out. */
const seedUnmergedBranch = (dir: string, name: string): void => {
  git(dir, 'checkout', '-q', '-b', name);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'ahead');
  git(dir, 'checkout', '-q', 'main');
};

/** Whether `name` still names something, read back through git itself. */
const branchSurvives = (dir: string, name: string): boolean =>
  tryRunGitWithExit(['-C', dir, 'show-ref', '--verify', `refs/heads/${name}`]).exitCode === 0;

const catchTsgitError = async (thrower: () => Promise<unknown>): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await thrower();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe.skipIf(!GIT_AVAILABLE)('branch delete — worktree holders interop', () => {
  const caseRoots: string[] = [];

  /** One repository per row: rows delete refs and register worktrees, so no
   *  two of them may share a checkout — nor a repository facade, whose
   *  session cache would otherwise outlive the tree it was opened on. */
  const caseRepo = async (slug: string): Promise<string> => {
    // Realpath'd: git records the resolved path in a linked worktree's
    // `gitdir` pointer and echoes it back in the refusal, so an unresolved
    // root would not match the bytes under comparison.
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-del-${slug}-`)));
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
    return dir;
  };

  /** tsgit's own delete, run through the facade so a linked worktree's
   *  registration is discoverable from the main checkout. */
  const deleteWithTsgit = async (dir: string, name: string): Promise<TsgitError | undefined> => {
    const repo = await openRepository({ cwd: dir });
    try {
      return await catchTsgitError(() => branchDelete(repo.ctx, { name }));
    } finally {
      await repo.dispose();
    }
  };

  const expectDeleted = async (
    dir: string,
    input: { readonly name: string; readonly force?: boolean },
  ): Promise<void> => {
    const repo = await openRepository({ cwd: dir });
    try {
      const result = await branchDelete(repo.ctx, input);
      expect(result.name).toBe(`refs/heads/${input.name}`);
    } finally {
      await repo.dispose();
    }
  };

  const deleteWithTsgitExpectingSuccess = (dir: string, name: string): Promise<void> =>
    expectDeleted(dir, { name });

  /** tsgit's counterpart to git's `-D`. */
  const forceDeleteWithTsgit = (dir: string, name: string): Promise<void> =>
    expectDeleted(dir, { name, force: true });

  afterAll(async () => {
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  describe('Given a branch the current checkout holds', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both refuse, naming the branch and the checkout holding it',
        async () => {
          // Arrange
          const peer = await caseRepo('held-current-peer');
          const dir = await caseRepo('held-current');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'main']);
          const err = await deleteWithTsgit(dir, 'main');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(heldLine('main', peer));
          expect(err?.data).toEqual({
            code: 'BRANCH_CHECKED_OUT',
            branch: 'refs/heads/main',
            path: dir,
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch only a linked worktree holds', () => {
    describe('When git branch -d and tsgit branchDelete both target it from the main checkout', () => {
      it(
        'Then both refuse, naming the linked worktree rather than the current one',
        async () => {
          // Arrange
          const peer = await caseRepo('held-linked-peer');
          const peerLinked = path.join(peer, '..', 'linked');
          git(peer, 'worktree', 'add', '-q', peerLinked, '-b', 'sidecar');
          const dir = await caseRepo('held-linked');
          const linked = path.join(dir, '..', 'linked');
          git(dir, 'worktree', 'add', '-q', linked, '-b', 'sidecar');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'sidecar']);
          const err = await deleteWithTsgit(dir, 'sidecar');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(heldLine('sidecar', peerLinked));
          expect(err?.data).toEqual({
            code: 'BRANCH_CHECKED_OUT',
            branch: 'refs/heads/sidecar',
            path: linked,
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a linked worktree whose directory is gone but whose registration survives', () => {
    describe('When git branch -d and tsgit branchDelete both target its branch', () => {
      it(
        'Then both still refuse, naming the path that no longer exists',
        async () => {
          // Arrange
          const peer = await caseRepo('stale-peer');
          const peerLinked = path.join(peer, '..', 'linked');
          git(peer, 'worktree', 'add', '-q', peerLinked, '-b', 'sidecar');
          await rm(peerLinked, { recursive: true, force: true });
          const dir = await caseRepo('stale');
          const linked = path.join(dir, '..', 'linked');
          git(dir, 'worktree', 'add', '-q', linked, '-b', 'sidecar');
          await rm(linked, { recursive: true, force: true });

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'sidecar']);
          const err = await deleteWithTsgit(dir, 'sidecar');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(heldLine('sidecar', peerLinked));
          expect(err?.data).toEqual({
            code: 'BRANCH_CHECKED_OUT',
            branch: 'refs/heads/sidecar',
            path: linked,
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given that same registration once worktree prune has cleared it', () => {
    describe('When git branch -d and tsgit branchDelete both target its branch', () => {
      it(
        'Then both delete it',
        async () => {
          // Arrange
          const peer = await caseRepo('pruned-peer');
          const peerLinked = path.join(peer, '..', 'linked');
          git(peer, 'worktree', 'add', '-q', peerLinked, '-b', 'sidecar');
          await rm(peerLinked, { recursive: true, force: true });
          git(peer, 'worktree', 'prune');
          const dir = await caseRepo('pruned');
          const linked = path.join(dir, '..', 'linked');
          git(dir, 'worktree', 'add', '-q', linked, '-b', 'sidecar');
          await rm(linked, { recursive: true, force: true });
          git(dir, 'worktree', 'prune');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'sidecar']);
          await deleteWithTsgitExpectingSuccess(dir, 'sidecar');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(
            tryRunGitWithExit(['-C', peer, 'rev-parse', '--verify', 'refs/heads/sidecar']).exitCode,
          ).toBe(128);
          expect(
            tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', 'refs/heads/sidecar']).exitCode,
          ).toBe(128);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a worktree sitting on a detached HEAD at the branch tip', () => {
    describe('When git branch -d and tsgit branchDelete both target that branch', () => {
      it(
        'Then both delete it, because a detached HEAD names no branch',
        async () => {
          // Arrange
          const peer = await caseRepo('detached-peer');
          const peerLinked = path.join(peer, '..', 'linked');
          git(peer, 'worktree', 'add', '-q', peerLinked, '-b', 'sidecar');
          git(peerLinked, 'checkout', '-q', '--detach');
          const dir = await caseRepo('detached');
          const linked = path.join(dir, '..', 'linked');
          git(dir, 'worktree', 'add', '-q', linked, '-b', 'sidecar');
          git(linked, 'checkout', '-q', '--detach');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'sidecar']);
          await deleteWithTsgitExpectingSuccess(dir, 'sidecar');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(
            tryRunGitWithExit(['-C', peer, 'rev-parse', '--verify', 'refs/heads/sidecar']).exitCode,
          ).toBe(128);
          expect(
            tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', 'refs/heads/sidecar']).exitCode,
          ).toBe(128);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a bare repository whose HEAD names a branch and no linked worktree', () => {
    describe('When git branch -d and tsgit branchDelete both target that branch', () => {
      it(
        'Then both delete it, because a bare checkout holds nothing',
        async () => {
          // Arrange
          const peerSource = await caseRepo('bare-free-peer');
          const peer = path.join(peerSource, '..', 'bare.git');
          runGit(['clone', '-q', '--bare', peerSource, peer]);
          const source = await caseRepo('bare-free');
          const dir = path.join(source, '..', 'bare.git');
          runGit(['clone', '-q', '--bare', source, dir]);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'main']);
          await deleteWithTsgitExpectingSuccess(dir, 'main');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(
            tryRunGitWithExit(['-C', peer, 'rev-parse', '--verify', 'refs/heads/main']).exitCode,
          ).toBe(128);
          expect(
            tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', 'refs/heads/main']).exitCode,
          ).toBe(128);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a bare repository with a linked worktree holding the branch', () => {
    describe('When git branch -d and tsgit branchDelete both target that branch', () => {
      it(
        'Then both refuse, naming the linked worktree',
        async () => {
          // Arrange
          const peerSource = await caseRepo('bare-held-peer');
          const peer = path.join(peerSource, '..', 'bare.git');
          runGit(['clone', '-q', '--bare', peerSource, peer]);
          const peerLinked = path.join(peerSource, '..', 'linked');
          git(peer, 'worktree', 'add', '-q', peerLinked, 'main');
          const source = await caseRepo('bare-held');
          const dir = path.join(source, '..', 'bare.git');
          runGit(['clone', '-q', '--bare', source, dir]);
          const linked = path.join(source, '..', 'linked');
          git(dir, 'worktree', 'add', '-q', linked, 'main');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'main']);
          const err = await deleteWithTsgit(dir, 'main');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(heldLine('main', peerLinked));
          expect(err?.data).toEqual({
            code: 'BRANCH_CHECKED_OUT',
            branch: 'refs/heads/main',
            path: linked,
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch that is both held by a worktree and unmerged', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both report the worktree, never the unmerged tip',
        async () => {
          // Arrange
          const peer = await caseRepo('held-unmerged-peer');
          const peerLinked = path.join(peer, '..', 'linked');
          git(peer, 'worktree', 'add', '-q', peerLinked, '-b', 'sidecar');
          git(peerLinked, 'commit', '-q', '--allow-empty', '-m', 'ahead');
          const dir = await caseRepo('held-unmerged');
          const linked = path.join(dir, '..', 'linked');
          git(dir, 'worktree', 'add', '-q', linked, '-b', 'sidecar');
          git(linked, 'commit', '-q', '--allow-empty', '-m', 'ahead');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'branch', '-d', 'sidecar']);
          const err = await deleteWithTsgit(dir, 'sidecar');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(heldLine('sidecar', peerLinked));
          expect(err?.data).toEqual({
            code: 'BRANCH_CHECKED_OUT',
            branch: 'refs/heads/sidecar',
            path: linked,
          });
        },
        ROW_TIMEOUT,
      );
    });
  });
  describe('Given a branch carrying a commit HEAD does not contain', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both refuse and the branch survives',
        async () => {
          // Arrange
          const peer = await caseRepo('unmerged-peer');
          seedUnmergedBranch(peer, 'topic');
          const dir = await caseRepo('unmerged');
          seedUnmergedBranch(dir, 'topic');

          // Act
          const gitResult = quietDelete(peer, '-d', 'topic');
          const err = await deleteWithTsgit(dir, 'topic');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(unmergedLine('topic'));
          expect(err?.data).toEqual({
            code: 'BRANCH_NOT_FULLY_MERGED',
            name: 'refs/heads/topic',
          });
          expect(branchSurvives(peer, 'topic')).toBe(true);
          expect(branchSurvives(dir, 'topic')).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When both delete it with force instead', () => {
      it(
        'Then both remove it and exit clean',
        async () => {
          // Arrange
          const peer = await caseRepo('unmerged-forced-peer');
          seedUnmergedBranch(peer, 'topic');
          const dir = await caseRepo('unmerged-forced');
          seedUnmergedBranch(dir, 'topic');

          // Act
          const gitResult = quietDelete(peer, '-D', 'topic');
          await forceDeleteWithTsgit(dir, 'topic');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(branchSurvives(peer, 'topic')).toBe(false);
          expect(branchSurvives(dir, 'topic')).toBe(false);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch merged into its configured upstream but not into HEAD', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both delete it — the upstream stands in for HEAD',
        async () => {
          // Arrange
          const seed = (dir: string): void => {
            seedUnmergedBranch(dir, 'topic');
            git(dir, 'branch', 'up', 'topic');
            git(dir, 'branch', '--set-upstream-to=up', 'topic');
          };
          const peer = await caseRepo('upstream-merged-peer');
          seed(peer);
          const dir = await caseRepo('upstream-merged');
          seed(dir);

          // Act
          const gitResult = quietDelete(peer, '-d', 'topic');
          await deleteWithTsgitExpectingSuccess(dir, 'topic');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe(
            "warning: deleting branch 'topic' that has been merged to\n" +
              "         'refs/heads/up', but not yet merged to HEAD\n",
          );
          expect(branchSurvives(peer, 'topic')).toBe(false);
          expect(branchSurvives(dir, 'topic')).toBe(false);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch merged into HEAD but behind its configured upstream', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both still refuse — an upstream replaces HEAD rather than widening it',
        async () => {
          // Arrange
          const seed = (dir: string): void => {
            const root = git(dir, 'rev-parse', 'HEAD').trim();
            seedUnmergedBranch(dir, 'topic');
            git(dir, 'merge', '-q', '--no-ff', '-m', 'merge topic', 'topic');
            git(dir, 'branch', 'up', root);
            git(dir, 'branch', '--set-upstream-to=up', 'topic');
          };
          const peer = await caseRepo('upstream-behind-peer');
          seed(peer);
          const dir = await caseRepo('upstream-behind');
          seed(dir);

          // Act
          const gitResult = quietDelete(peer, '-d', 'topic');
          const err = await deleteWithTsgit(dir, 'topic');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(
            "warning: not deleting branch 'topic' that is not yet merged to\n" +
              "         'refs/heads/up', even though it is merged to HEAD\n" +
              unmergedLine('topic'),
          );
          expect(err?.data).toEqual({
            code: 'BRANCH_NOT_FULLY_MERGED',
            name: 'refs/heads/topic',
          });
          expect(branchSurvives(dir, 'topic')).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch whose content reached HEAD only through a squash', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both refuse — reachability decides, never content',
        async () => {
          // Arrange
          const seed = async (dir: string): Promise<void> => {
            git(dir, 'checkout', '-q', '-b', 'topic');
            await writeFile(path.join(dir, 'topic.txt'), 'topic\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'topic work');
            git(dir, 'checkout', '-q', 'main');
            git(dir, 'merge', '-q', '--squash', 'topic');
            git(dir, 'commit', '-q', '-m', 'squashed topic');
          };
          const peer = await caseRepo('squashed-peer');
          await seed(peer);
          const dir = await caseRepo('squashed');
          await seed(dir);

          // Act
          const gitResult = quietDelete(peer, '-d', 'topic');
          const err = await deleteWithTsgit(dir, 'topic');

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(unmergedLine('topic'));
          expect(err?.data).toEqual({
            code: 'BRANCH_NOT_FULLY_MERGED',
            name: 'refs/heads/topic',
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a symbolic branch pointing at a branch HEAD does not contain', () => {
    describe('When git branch -d and tsgit branchDelete both target the symbolic name', () => {
      it(
        'Then both delete it unchecked and leave its target alone',
        async () => {
          // Arrange
          const seed = (dir: string): void => {
            seedUnmergedBranch(dir, 'topic');
            git(dir, 'symbolic-ref', 'refs/heads/sym', 'refs/heads/topic');
          };
          const peer = await caseRepo('symref-unmerged-peer');
          seed(peer);
          const dir = await caseRepo('symref-unmerged');
          seed(dir);

          // Act
          const gitResult = quietDelete(peer, '-d', 'sym');
          await deleteWithTsgitExpectingSuccess(dir, 'sym');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(branchSurvives(peer, 'sym')).toBe(false);
          expect(branchSurvives(peer, 'topic')).toBe(true);
          expect(branchSurvives(dir, 'sym')).toBe(false);
          expect(branchSurvives(dir, 'topic')).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

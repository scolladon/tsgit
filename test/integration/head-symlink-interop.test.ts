/**
 * Cross-tool interop — a symlinked `HEAD`.
 *
 * Pins two behaviours against real git 2.55.0 on the SAME on-disk repository
 * both tools operate on:
 *
 *  - H1: a symlink whose link text names `refs/heads/main` resolves
 *    SYMBOLIC — `git symbolic-ref HEAD` reports the branch, and a commit
 *    advances it — matching the single HEAD-reader fix (a symlinked HEAD
 *    used to resolve `direct`/detached).
 *  - H2: a symlink whose link text does NOT begin `refs/` makes git's own
 *    discovery fail outright (`fatal: not a git repository`, exit 128,
 *    measured — every git subcommand refuses, not just `symbolic-ref`);
 *    tsgit's operational gate refuses the same directory with
 *    `NOT_A_REPOSITORY`.
 *
 * @proves
 *   surface:        rev-parse, branch.list, commit
 *   bucket:         cross-tool-interop
 *   unique:         a symlinked HEAD resolves symbolic (not detached),
 *                    matching git 2.55.0; a non-refs/ link fails the same
 *                    way discovery does
 *   interopSurface: HEAD
 */
import { symlinkSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList } from '../../src/application/commands/branch.js';
import { commit } from '../../src/application/commands/commit.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { currentBranchRef } from '../../src/application/primitives/internal/repo-state.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  tryRunGitWithExit,
} from './interop-helpers.js';

/** Replace `<dir>/.git/HEAD` (a regular ref file) with a real OS symlink. */
const replaceHeadWithSymlink = (dir: string, linkText: string): void => {
  const headPath = path.join(dir, '.git', 'HEAD');
  unlinkSync(headPath);
  symlinkSync(linkText, headPath);
};

describe.skipIf(!GIT_AVAILABLE)('head symlink interop', () => {
  describe('Given HEAD is a symlink whose link text names refs/heads/main', () => {
    let pair: PeerPair;
    let ctx: Context;

    beforeAll(async () => {
      pair = await makePeerPair('head-symlink-refs');
      initBothRepos(pair.peer, pair.ours);
      disableAutoMaintenance(pair.ours);
      git(pair.ours, 'commit', '-q', '--allow-empty', '-m', 'root');
      replaceHeadWithSymlink(pair.ours, 'refs/heads/main');
      ctx = createNodeContext({ workDir: pair.ours });
    }, 60_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When git symbolic-ref and tsgit currentBranchRef both run', () => {
      it('Then both report refs/heads/main — the symlink resolves symbolic, not detached', async () => {
        // Arrange
        const gitSymbolicRef = git(pair.ours, 'symbolic-ref', 'HEAD').trim();

        // Act
        const result = await currentBranchRef(ctx);

        // Assert
        expect(gitSymbolicRef).toBe('refs/heads/main');
        expect(result).toBe('refs/heads/main');
      });
    });

    describe('When git rev-parse HEAD and tsgit revParse(HEAD) both run', () => {
      it('Then they agree on the same object id', async () => {
        // Arrange
        const gitOid = git(pair.ours, 'rev-parse', 'HEAD').trim();

        // Act
        const result = await revParse(ctx, 'HEAD');

        // Assert
        expect(result).toBe(gitOid);
      });
    });

    describe('When branchList runs', () => {
      it('Then refs/heads/main is reported current', async () => {
        // Arrange
        const sut = branchList;

        // Act
        const result = await sut(ctx);

        // Assert
        const main = result.branches.find((b) => b.name === 'refs/heads/main');
        expect(main?.current).toBe(true);
      });
    });

    describe('When a commit runs through tsgit', () => {
      it('Then it advances refs/heads/main and HEAD stays symbolic — never detached', async () => {
        // Arrange
        const before = git(pair.ours, 'rev-parse', 'refs/heads/main').trim();

        // Act
        await commit(ctx, { message: 'advance via tsgit', allowEmpty: true });

        // Assert
        const after = git(pair.ours, 'rev-parse', 'refs/heads/main').trim();
        expect(after).not.toBe(before);
        expect(git(pair.ours, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
      });
    });
  });

  describe('Given HEAD is a symlink whose link text does not begin refs/', () => {
    let pair: PeerPair;
    let ctx: Context;

    beforeAll(async () => {
      pair = await makePeerPair('head-symlink-non-refs');
      initBothRepos(pair.peer, pair.ours);
      disableAutoMaintenance(pair.ours);
      git(pair.ours, 'commit', '-q', '--allow-empty', '-m', 'root');
      replaceHeadWithSymlink(pair.ours, '../outside-of-refs');
      ctx = createNodeContext({ workDir: pair.ours });
    }, 60_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When git and tsgit both try to read the repository', () => {
      it('Then git discovery fails (exit 128) and tsgit refuses NOT_A_REPOSITORY', async () => {
        // Arrange — measured: EVERY git subcommand refuses identically here,
        // not just `symbolic-ref` — discovery itself fails, so `--git-dir`
        // pins the same class of refusal `revParse` is compared against.
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'rev-parse', '--git-dir']);

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });
});

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
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList } from '../../src/application/commands/branch.js';
import { commit } from '../../src/application/commands/commit.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { status } from '../../src/application/commands/status.js';
import { currentBranchRef } from '../../src/application/primitives/internal/repo-state.js';
import { resolveRef } from '../../src/application/primitives/resolve-ref.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
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

  describe('Given HEAD is a symlink whose link text is not a valid refname', () => {
    const SETUP_TIMEOUT = 60_000;
    let baseDir: string;
    let sideOid: string;
    let mainOid: string;
    const caseRoots: string[] = [];

    const cloneRepo = async (slug: string): Promise<string> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-head-symlink-format-${slug}-`));
      caseRoots.push(root);
      const target = path.join(root, 'repo');
      await cp(baseDir, target, { recursive: true });
      return target;
    };

    /** Twin copies of the base — one for git's own read+commit, one for tsgit's — seeded
     *  identically and each given the same symlinked HEAD. */
    const setupTwins = async (
      slug: string,
      linkText: string,
      seed?: (dir: string) => void,
    ): Promise<{ readonly gitDir: string; readonly tsgitDir: string; readonly ctx: Context }> => {
      const gitDir = await cloneRepo(`${slug}-git`);
      const tsgitDir = await cloneRepo(`${slug}-tsgit`);
      for (const dir of [gitDir, tsgitDir]) {
        seed?.(dir);
        replaceHeadWithSymlink(dir, linkText);
      }
      return { gitDir, tsgitDir, ctx: createNodeContext({ workDir: tsgitDir }) };
    };

    const writeLooseRef = (dir: string, name: string, content: string): void => {
      const refPath = path.join(dir, '.git', 'refs', 'heads', name);
      mkdirSync(path.dirname(refPath), { recursive: true });
      writeFileSync(refPath, content);
    };

    const isHeadSymlink = (dir: string): boolean =>
      lstatSync(path.join(dir, '.git', 'HEAD')).isSymbolicLink();

    beforeAll(async () => {
      baseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-head-symlink-format-base-'));
      runGit(['init', '-q', '-b', 'main', baseDir]);
      git(baseDir, 'config', 'user.name', 'Ada');
      git(baseDir, 'config', 'user.email', 'ada@example.com');
      git(baseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(baseDir);
      git(baseDir, 'commit', '-q', '--allow-empty', '-m', 'root');
      mainOid = git(baseDir, 'rev-parse', 'main').trim();
      git(baseDir, 'branch', 'side');
      git(baseDir, 'checkout', '-q', 'side');
      git(baseDir, 'commit', '-q', '--allow-empty', '-m', 'on side');
      sideOid = git(baseDir, 'rev-parse', 'side').trim();
      git(baseDir, 'checkout', '-q', 'main');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    describe('Given the link text names a file holding another branch’s oid', () => {
      describe('When HEAD is resolved and then committed through', () => {
        it('Then it resolves detached to that oid, symbolic-ref refuses, and commit writes a regular HEAD file leaving the target unchanged', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins('f2', 'refs/heads/a..b', (dir) =>
            writeLooseRef(dir, 'a..b', `${sideOid}\n`),
          );

          // Act
          const gitRevParse = git(gitDir, 'rev-parse', 'HEAD').trim();
          const gitSymbolicRef = tryRunGitWithExit(['-C', gitDir, 'symbolic-ref', 'HEAD']);
          const tsgitOid = await revParse(ctx, 'HEAD');
          const tsgitBranch = await currentBranchRef(ctx);
          git(gitDir, 'commit', '-q', '--allow-empty', '-m', 'via git');
          await commit(ctx, { message: 'via tsgit', allowEmpty: true });

          // Assert
          expect(gitRevParse).toBe(sideOid);
          expect(tsgitOid).toBe(sideOid);
          expect(gitSymbolicRef.exitCode).toBe(128);
          expect(tsgitBranch).toBeUndefined();
          expect(isHeadSymlink(gitDir)).toBe(false);
          expect(isHeadSymlink(tsgitDir)).toBe(false);
          expect(git(gitDir, 'rev-parse', 'HEAD^').trim()).toBe(sideOid);
          expect(git(tsgitDir, 'rev-parse', 'HEAD^').trim()).toBe(sideOid);
          expect(readFileSync(path.join(gitDir, '.git', 'refs', 'heads', 'a..b'), 'utf8')).toBe(
            `${sideOid}\n`,
          );
          expect(readFileSync(path.join(tsgitDir, '.git', 'refs', 'heads', 'a..b'), 'utf8')).toBe(
            `${sideOid}\n`,
          );
        });
      });
    });

    describe('Given the link text names a file holding a symbolic-ref line', () => {
      describe('When HEAD is resolved and then committed through', () => {
        it('Then it resolves symbolic to the named branch on both, and commit advances that branch leaving the link in place', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins('f3', 'refs/heads/a..b', (dir) =>
            writeLooseRef(dir, 'a..b', 'ref: refs/heads/side\n'),
          );

          // Act
          const gitRevParse = git(gitDir, 'rev-parse', 'HEAD').trim();
          const gitSymbolicRef = git(gitDir, 'symbolic-ref', 'HEAD').trim();
          const tsgitOid = await revParse(ctx, 'HEAD');
          const tsgitBranch = await currentBranchRef(ctx);
          git(gitDir, 'commit', '-q', '--allow-empty', '-m', 'via git');
          await commit(ctx, { message: 'via tsgit', allowEmpty: true });

          // Assert
          expect(gitRevParse).toBe(sideOid);
          expect(tsgitOid).toBe(sideOid);
          expect(gitSymbolicRef).toBe('refs/heads/side');
          expect(tsgitBranch).toBe('refs/heads/side');
          expect(isHeadSymlink(gitDir)).toBe(true);
          expect(isHeadSymlink(tsgitDir)).toBe(true);
          expect(git(gitDir, 'rev-parse', 'side').trim()).not.toBe(sideOid);
          expect(git(tsgitDir, 'rev-parse', 'side').trim()).not.toBe(sideOid);
        });
      });
    });

    describe('Given the link text is a `..`-relative path resolving to a valid refname', () => {
      describe('When HEAD is resolved and then committed through', () => {
        it('Then it resolves detached to that branch and commit writes a regular HEAD file leaving the branch unchanged', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins('f4', 'refs/heads/../heads/side');

          // Act
          const gitRevParse = git(gitDir, 'rev-parse', 'HEAD').trim();
          const gitSymbolicRef = tryRunGitWithExit(['-C', gitDir, 'symbolic-ref', 'HEAD']);
          const tsgitOid = await revParse(ctx, 'HEAD');
          git(gitDir, 'commit', '-q', '--allow-empty', '-m', 'via git');
          await commit(ctx, { message: 'via tsgit', allowEmpty: true });

          // Assert
          expect(gitRevParse).toBe(sideOid);
          expect(tsgitOid).toBe(sideOid);
          expect(gitSymbolicRef.exitCode).toBe(128);
          expect(isHeadSymlink(gitDir)).toBe(false);
          expect(isHeadSymlink(tsgitDir)).toBe(false);
          expect(git(gitDir, 'rev-parse', 'side').trim()).toBe(sideOid);
          expect(git(tsgitDir, 'rev-parse', 'side').trim()).toBe(sideOid);
        });
      });
    });

    describe.each([
      { label: 'a `.lock`-suffixed link text', refName: 'x.lock', linkText: 'refs/heads/x.lock' },
      { label: 'a link text carrying a space', refName: 'sp ace', linkText: 'refs/heads/sp ace' },
    ])('Given $label naming a file holding the main branch’s oid', ({ refName, linkText }) => {
      describe('When HEAD is resolved and then committed through', () => {
        it('Then it resolves detached to that oid, symbolic-ref refuses, and commit writes a regular HEAD file', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins(refName, linkText, (dir) =>
            writeLooseRef(dir, refName, `${mainOid}\n`),
          );

          // Act
          const gitRevParse = git(gitDir, 'rev-parse', 'HEAD').trim();
          const gitSymbolicRef = tryRunGitWithExit(['-C', gitDir, 'symbolic-ref', 'HEAD']);
          const tsgitOid = await revParse(ctx, 'HEAD');
          git(gitDir, 'commit', '-q', '--allow-empty', '-m', 'via git');
          await commit(ctx, { message: 'via tsgit', allowEmpty: true });

          // Assert
          expect(gitRevParse).toBe(mainOid);
          expect(tsgitOid).toBe(mainOid);
          expect(gitSymbolicRef.exitCode).toBe(128);
          expect(isHeadSymlink(gitDir)).toBe(false);
          expect(isHeadSymlink(tsgitDir)).toBe(false);
        });
      });
    });

    describe('Given the link text names a branch that does not exist yet', () => {
      describe('When HEAD is resolved and then committed through', () => {
        it('Then it resolves symbolic on both and commit creates the branch, keeping the link', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins('f7', 'refs/heads/valid-dangling');

          // Act
          const gitSymbolicRef = git(gitDir, 'symbolic-ref', 'HEAD').trim();
          const tsgitBranch = await currentBranchRef(ctx);
          git(gitDir, 'commit', '-q', '--allow-empty', '-m', 'via git');
          await commit(ctx, { message: 'via tsgit', allowEmpty: true });

          // Assert
          expect(gitSymbolicRef).toBe('refs/heads/valid-dangling');
          expect(tsgitBranch).toBe('refs/heads/valid-dangling');
          expect(isHeadSymlink(gitDir)).toBe(true);
          expect(isHeadSymlink(tsgitDir)).toBe(true);
          expect(git(gitDir, 'rev-parse', 'refs/heads/valid-dangling').trim()).toMatch(
            /^[0-9a-f]+$/,
          );
          expect(git(tsgitDir, 'rev-parse', 'refs/heads/valid-dangling').trim()).toMatch(
            /^[0-9a-f]+$/,
          );
        });
      });
    });

    describe('Given the link text names an absent target — a residual (git and tsgit disagree)', () => {
      describe('When HEAD is resolved, status runs, and commit is attempted', () => {
        it('Then git reads a detached, unborn HEAD and writes it on commit, while tsgit refuses REF_NOT_FOUND throughout', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins('f1', 'refs/heads/a..b');

          // Act
          const gitRevParse = tryRunGitWithExit(['-C', gitDir, 'rev-parse', 'HEAD']);
          const gitStatus = tryRunGitWithExit([
            '-C',
            gitDir,
            'status',
            '--porcelain=v2',
            '--branch',
          ]);
          let tsgitResolveCaught: unknown;
          try {
            await resolveRef(ctx, 'HEAD');
          } catch (err) {
            tsgitResolveCaught = err;
          }
          let tsgitStatusCaught: unknown;
          try {
            await status(ctx);
          } catch (err) {
            tsgitStatusCaught = err;
          }
          const gitCommit = tryRunGitWithExit([
            '-C',
            gitDir,
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'via git',
          ]);
          let tsgitCommitCaught: unknown;
          try {
            await commit(ctx, { message: 'via tsgit', allowEmpty: true });
          } catch (err) {
            tsgitCommitCaught = err;
          }

          // Assert — git: detached, unborn HEAD; a commit writes a regular HEAD file
          expect(gitRevParse.exitCode).toBe(128);
          expect(gitStatus.exitCode).toBe(0);
          expect(gitStatus.stdout).toContain('# branch.oid (initial)');
          expect(gitStatus.stdout).toContain('# branch.head (detached)');
          expect(gitCommit.exitCode).toBe(0);
          expect(isHeadSymlink(gitDir)).toBe(false);

          // Assert — tsgit: every surface refuses REF_NOT_FOUND, the link untouched
          expect(tsgitResolveCaught).toBeInstanceOf(TsgitError);
          expect((tsgitResolveCaught as TsgitError).data.code).toBe('REF_NOT_FOUND');
          expect(tsgitStatusCaught).toBeInstanceOf(TsgitError);
          expect((tsgitStatusCaught as TsgitError).data.code).toBe('REF_NOT_FOUND');
          expect(tsgitCommitCaught).toBeInstanceOf(TsgitError);
          expect((tsgitCommitCaught as TsgitError).data.code).toBe('REF_NOT_FOUND');
          expect(isHeadSymlink(tsgitDir)).toBe(true);
        });
      });
    });

    describe('Given the link text names a directory — a residual (git and tsgit disagree on status)', () => {
      describe('When HEAD is resolved, status runs, and commit is attempted', () => {
        it('Then git reads a detached, unborn HEAD via status while tsgit refuses, and both refuse commit', async () => {
          // Arrange
          const { gitDir, tsgitDir, ctx } = await setupTwins('f6', 'refs/heads/a..b', (dir) =>
            mkdirSync(path.join(dir, '.git', 'refs', 'heads', 'a..b'), { recursive: true }),
          );

          // Act
          const gitRevParse = tryRunGitWithExit(['-C', gitDir, 'rev-parse', 'HEAD']);
          const gitStatus = tryRunGitWithExit([
            '-C',
            gitDir,
            'status',
            '--porcelain=v2',
            '--branch',
          ]);
          let tsgitResolveCaught: unknown;
          try {
            await resolveRef(ctx, 'HEAD');
          } catch (err) {
            tsgitResolveCaught = err;
          }
          let tsgitStatusCaught: unknown;
          try {
            await status(ctx);
          } catch (err) {
            tsgitStatusCaught = err;
          }
          const gitCommit = tryRunGitWithExit([
            '-C',
            gitDir,
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'via git',
          ]);
          let tsgitCommitCaught: unknown;
          try {
            await commit(ctx, { message: 'via tsgit', allowEmpty: true });
          } catch (err) {
            tsgitCommitCaught = err;
          }

          // Assert — git: detached, unborn HEAD reads fine via status; commit refuses (cannot lock)
          expect(gitRevParse.exitCode).toBe(128);
          expect(gitStatus.exitCode).toBe(0);
          expect(gitStatus.stdout).toContain('# branch.oid (initial)');
          expect(gitStatus.stdout).toContain('# branch.head (detached)');
          expect(gitCommit.exitCode).toBe(128);

          // Assert — tsgit: every surface refuses REF_NOT_FOUND, the link untouched
          expect(tsgitResolveCaught).toBeInstanceOf(TsgitError);
          expect((tsgitResolveCaught as TsgitError).data.code).toBe('REF_NOT_FOUND');
          expect(tsgitStatusCaught).toBeInstanceOf(TsgitError);
          expect((tsgitStatusCaught as TsgitError).data.code).toBe('REF_NOT_FOUND');
          expect(tsgitCommitCaught).toBeInstanceOf(TsgitError);
          expect((tsgitCommitCaught as TsgitError).data.code).toBe('REF_NOT_FOUND');
          expect(isHeadSymlink(tsgitDir)).toBe(true);
        });
      });
    });
  });
  describe('Given HEAD is a symlink leaving the repository to a file that does not hold a ref', () => {
    const SECRET = 'PRIVATE-LINE';
    let pair: PeerPair;
    let ctx: Context;

    beforeAll(async () => {
      pair = await makePeerPair('head-symlink-broken');
      initBothRepos(pair.peer, pair.ours);
      disableAutoMaintenance(pair.ours);
      git(pair.ours, 'commit', '-q', '--allow-empty', '-m', 'root');
      writeFileSync(path.join(pair.peer, 'secret.txt'), `${SECRET}\n`);
      replaceHeadWithSymlink(pair.ours, `refs/../../../${path.basename(pair.peer)}/secret.txt`);
      ctx = createNodeContext({ workDir: pair.ours });
    }, 60_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When git branch and tsgit branchList both run', () => {
      it('Then both refuse, and neither surfaces a byte of the followed file', async () => {
        // Arrange
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch']);
        const sut = branchList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain('failed to resolve HEAD as a valid ref');
        expect(gitResult.stderr).not.toContain(SECRET);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'HEAD is a symbolic link to content that is not a ref',
        });
      });
    });

    describe('When git status and tsgit status both run', () => {
      it('Then git reports no commits yet while tsgit refuses without the followed bytes — a recorded residual', async () => {
        // Arrange
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'status']);
        const sut = status;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout).toContain('No commits yet');
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'HEAD is a symbolic link to content that is not a ref',
        });
      });
    });
  });
});

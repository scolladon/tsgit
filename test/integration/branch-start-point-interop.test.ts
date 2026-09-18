/**
 * Cross-tool interop — `branch.create`'s start-point typing. One shared
 * repository, built once with canonical git (a commit, a tree, a blob, a
 * lightweight tag over the tree, and annotated tags over the tree and over
 * the commit); every `it` runs canonical git's own `branch` refusal as the
 * oracle and tsgit's `branchCreate` as the subject against that SAME
 * on-disk repository. Pins git's exact refusal ordering and shape: exit
 * codes, the `error:`/`fatal:` lines reconstructed from tsgit's thrown
 * `{ id, expected, actual }` plus the caller's own start point, and the
 * peel of an annotated tag to its commit. The typing rows pass
 * fully-qualified `refs/tags/<name>` start points on both sides so the two
 * callers hand over byte-identical strings; the ladder rows below pass the
 * bare names git's own `dwim_ref` expands, including the ambiguous one it
 * alone refuses.
 *
 * @proves
 *   surface:        branch.create
 *   bucket:         cross-tool-interop
 *   unique:         branch.create types its start point through the object
 *                    store — refusal exit codes and reconstructed error
 *                    lines, and annotated-tag peeling, match git 2.55.0
 *   interopSurface: branch
 */
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchCreate } from '../../src/application/commands/branch.js';
import { tagCreate } from '../../src/application/commands/tag.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

/** git's `error: object <id> is a <actual>, not a commit` — reconstructed from tsgit's thrown data. */
const errorLine = (id: string, actual: string): string =>
  `error: object ${id} is a ${actual}, not a commit\n`;

/** git's `fatal: not a valid branch point: '<start>'` — composed from the caller's own start point. */
const fatalLine = (startPoint: string): string =>
  `fatal: not a valid branch point: '${startPoint}'\n`;

/** The message field of a ref log's last line, read off disk so the two tools
 *  are compared on the same bytes rather than through either one's reader. */
const lastLogMessage = async (dir: string, ref: string): Promise<string> => {
  const text = await readFile(path.join(dir, '.git', 'logs', ref), 'utf8');
  return text.trimEnd().split('\n').at(-1)?.split('\t').at(1) ?? '';
};

const catchTsgitError = async (thrower: () => Promise<unknown>): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await thrower();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe.skipIf(!GIT_AVAILABLE)('branch start-point interop', () => {
  let base = '';
  let commitId = '';
  let treeId = '';
  let blobId = '';
  const caseRoots: string[] = [];

  /** A private copy of the shared fixture. Rows create refs, so no two of
   *  them may share a repository — nor a Context, whose session cache would
   *  otherwise outlive the copy it was opened on. */
  const caseRepo = async (
    slug: string,
  ): Promise<{ readonly dir: string; readonly ctx: Context }> => {
    // Realpath'd: git records the resolved path in a linked worktree's
    // `gitdir` pointer, and on a platform whose temp dir is itself a symlink
    // an unresolved root would not match what the pointer names.
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-start-point-${slug}-`)),
    );
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    await cp(base, dir, { recursive: true });
    return { dir, ctx: createNodeContext({ workDir: dir }) };
  };

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-branch-start-point-base-'));
    runGit(['init', '-q', '-b', 'main', base]);
    git(base, 'config', 'user.name', 'Ada');
    git(base, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(base);
    git(base, 'commit', '-q', '--allow-empty', '-m', 'root');
    commitId = git(base, 'rev-parse', 'HEAD').trim();
    treeId = git(base, 'write-tree').trim();
    blobId = git(base, 'hash-object', '-w', '--stdin').trim();
    git(base, 'tag', 'light-to-tree', treeId);
    git(base, 'tag', '-a', 'tag-to-tree', '-m', 'tag-to-tree', treeId);
    git(base, 'tag', '-a', 'tag-to-commit', '-m', 'tag-to-commit', commitId);
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  describe('Given no start point at all, with HEAD attached to a branch', () => {
    describe('When git branch and tsgit branchCreate both create a name', () => {
      it('Then both log the creation as cut from the current branch, not from HEAD', async () => {
        // Arrange — git resolves HEAD to its ref name and strips
        // `refs/heads/`, so the label carries the branch's own short name.
        const { dir, ctx } = await caseRepo('omitted-attached');

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-omit-git']);
        const result = await branchCreate(ctx, { name: 'b-omit-tsgit' });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
        expect(await lastLogMessage(dir, 'refs/heads/b-omit-git')).toBe(
          'branch: Created from main',
        );
        expect(await lastLogMessage(dir, 'refs/heads/b-omit-tsgit')).toBe(
          await lastLogMessage(dir, 'refs/heads/b-omit-git'),
        );
      });
    });
  });

  describe('Given no start point at all, with a detached HEAD', () => {
    describe('When git branch and tsgit branchCreate both create a name', () => {
      it('Then both log the creation as cut from HEAD, which names no branch', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('omitted-detached');
        git(dir, 'checkout', '-q', '--detach', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-det-git']);
        const result = await branchCreate(ctx, { name: 'b-det-tsgit' });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
        expect(await lastLogMessage(dir, 'refs/heads/b-det-git')).toBe('branch: Created from HEAD');
        expect(await lastLogMessage(dir, 'refs/heads/b-det-tsgit')).toBe(
          await lastLogMessage(dir, 'refs/heads/b-det-git'),
        );
      });
    });
  });

  describe('Given a fresh repository whose HEAD names a branch no commit backs', () => {
    /** An unborn checkout — `git init` and nothing else. Rows here cannot
     *  reuse the shared fixture, which carries a root commit. */
    const unbornRepo = async (
      slug: string,
    ): Promise<{ readonly dir: string; readonly ctx: Context }> => {
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-unborn-${slug}-`)),
      );
      caseRoots.push(root);
      const dir = path.join(root, 'repo');
      runGit(['init', '-q', '-b', 'main', dir]);
      disableAutoMaintenance(dir);
      return { dir, ctx: createNodeContext({ workDir: dir }) };
    };

    describe('When git branch and tsgit branchCreate both omit the start point', () => {
      it('Then both name the branch HEAD points at, never HEAD itself', async () => {
        // Arrange
        const { dir, ctx } = await unbornRepo('omitted');

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-unborn-git']);
        const err = await catchTsgitError(() => branchCreate(ctx, { name: 'b-unborn-tsgit' }));

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe("fatal: not a valid object name: 'main'\n");
        expect(err.data).toEqual({ code: 'BRANCH_NOT_FOUND', name: 'main' });
      });
    });

    describe('When git branch --force and tsgit branchCreate with force both omit the start point', () => {
      it('Then both refuse identically, force reaching no further', async () => {
        // Arrange
        const { dir, ctx } = await unbornRepo('omitted-force');

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', '--force', 'b-unborn-git']);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b-unborn-tsgit', force: true }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe("fatal: not a valid object name: 'main'\n");
        expect(err.data).toEqual({ code: 'BRANCH_NOT_FOUND', name: 'main' });
      });
    });

    describe('When git branch and tsgit branchCreate both pass a start point nothing resolves', () => {
      it('Then both name that start point verbatim rather than the current branch', async () => {
        // Arrange
        const { dir, ctx } = await unbornRepo('explicit');

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-unborn-git', 'nope-xyz']);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b-unborn-tsgit', startPoint: 'nope-xyz' }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe("fatal: not a valid object name: 'nope-xyz'\n");
        expect(err.data).toEqual({ code: 'BRANCH_NOT_FOUND', name: 'nope-xyz' });
      });
    });
  });

  describe('Given a branch the main worktree has checked out', () => {
    describe('When git branch --force and tsgit branchCreate with force both rewrite it', () => {
      it('Then both refuse, naming the branch and the worktree holding it', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('held-main');
        git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
        const older = git(dir, 'rev-parse', 'HEAD~1').trim();

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', '--force', 'main', older]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'main', startPoint: older, force: true }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(
          `fatal: cannot force update the branch 'main' used by worktree at '${dir}'\n`,
        );
        expect(err.data.code).toBe('BRANCH_CHECKED_OUT');
        if (err.data.code === 'BRANCH_CHECKED_OUT') {
          expect(err.data.branch).toBe('refs/heads/main');
          expect(err.data.path).toBe(dir);
        }
        expect(git(dir, 'rev-parse', 'refs/heads/main').trim()).not.toBe(older);
      });
    });

    describe('When git branch --force and tsgit branchCreate with force both pass a start point nothing resolves', () => {
      it('Then both refuse on the worktree, never reaching the start point', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('held-order');

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', '--force', 'main', 'nope-xyz']);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'main', startPoint: 'nope-xyz', force: true }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain("cannot force update the branch 'main'");
        expect(err.data.code).toBe('BRANCH_CHECKED_OUT');
      });
    });
  });

  describe('Given a branch only a linked worktree has checked out', () => {
    describe('When git branch --force and tsgit branch.create with force both rewrite it', () => {
      it('Then both refuse, naming the linked worktree rather than the current one', async () => {
        // Arrange — a linked worktree sits outside the main working tree, so
        // the repository facade (not a bare Context) is the caller that can
        // reach it.
        const { dir } = await caseRepo('held-linked');
        const linked = path.join(dir, '..', 'linked');
        git(dir, 'worktree', 'add', '-q', linked, '-b', 'sidecar');
        const repo = await openRepository({ cwd: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', '--force', 'sidecar', commitId]);
        const err = await catchTsgitError(() =>
          repo.branch.create({ name: 'sidecar', startPoint: commitId, force: true }),
        );
        await repo.dispose();

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(
          `fatal: cannot force update the branch 'sidecar' used by worktree at '${linked}'\n`,
        );
        expect(err.data.code).toBe('BRANCH_CHECKED_OUT');
        if (err.data.code === 'BRANCH_CHECKED_OUT') {
          expect(err.data.branch).toBe('refs/heads/sidecar');
          expect(err.data.path).toBe(linked);
        }
      });
    });
  });

  describe('Given a branch no worktree has checked out', () => {
    describe('When git branch --force and tsgit branchCreate with force both rewrite it', () => {
      it('Then both rewrite it and land on the same oid', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('free-branch');
        git(dir, 'branch', 'spare-git', commitId);
        await branchCreate(ctx, { name: 'spare-tsgit', startPoint: commitId });
        git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
        const moved = git(dir, 'rev-parse', 'HEAD').trim();

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', '--force', 'spare-git', moved]);
        const result = await branchCreate(ctx, {
          name: 'spare-tsgit',
          startPoint: moved,
          force: true,
        });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(git(dir, 'rev-parse', 'refs/heads/spare-git').trim()).toBe(moved);
        expect(result.id).toBe(moved);
      });
    });
  });

  describe('Given a branch a worktree cut from but then detached away from', () => {
    describe('When git branch --force and tsgit branch.create with force both rewrite it', () => {
      it('Then both accept — a detached HEAD holds no branch', async () => {
        // Arrange
        const { dir } = await caseRepo('detached-holder');
        const linked = path.join(dir, '..', 'detached');
        git(dir, 'worktree', 'add', '-q', linked, '-b', 'loose');
        git(linked, 'checkout', '-q', '--detach');
        const repo = await openRepository({ cwd: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', '--force', 'loose', commitId]);
        const result = await repo.branch.create({
          name: 'loose',
          startPoint: commitId,
          force: true,
        });
        await repo.dispose();

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
        expect(git(dir, 'rev-parse', 'refs/heads/loose').trim()).toBe(commitId);
      });
    });
  });

  describe('Given a bare repository whose HEAD names a branch', () => {
    describe('When git branch --force and tsgit branchCreate with force both rewrite it', () => {
      it('Then both accept — a bare main checkout holds no branch', async () => {
        // Arrange
        const { dir } = await caseRepo('bare-head');
        const bare = path.join(dir, '..', 'bare.git');
        runGit(['clone', '-q', '--bare', dir, bare]);
        const ctx = createNodeContext({ gitDir: bare, workDir: bare, bare: true });
        git(bare, 'branch', 'spare-git', commitId);
        git(bare, 'commit-tree', '-m', 'unused', treeId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', bare, 'branch', '--force', 'main', commitId]);
        const result = await branchCreate(ctx, { name: 'main', startPoint: commitId, force: true });

        // Assert
        expect(git(bare, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a bare name only one namespace carries', () => {
    describe('When git branch and tsgit branchCreate both cut from it', () => {
      it('Then both land on the same oid', async () => {
        // Arrange — a tag-only short name, which git expands through its
        // revision ladder rather than reading verbatim.
        const { dir, ctx } = await caseRepo('ladder');
        git(dir, 'tag', 'ladder-tag', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-ladder-git', 'ladder-tag']);
        const result = await branchCreate(ctx, {
          name: 'b-ladder-tsgit',
          startPoint: 'ladder-tag',
        });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
        expect(git(dir, 'rev-parse', 'refs/heads/b-ladder-git').trim()).toBe(result.id);
      });
    });
  });

  describe('Given a bare name two namespaces carry', () => {
    describe('When git branch and tsgit branchCreate both cut from it', () => {
      it('Then both refuse, naming the expression as ambiguous', async () => {
        // Arrange — the same short name as a branch AND a tag.
        const { dir, ctx } = await caseRepo('ambiguous');
        git(dir, 'branch', 'twice', commitId);
        git(dir, 'tag', 'twice', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-amb-git', 'twice']);
        const error = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b-amb-tsgit', startPoint: 'twice' }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain("fatal: ambiguous object name: 'twice'");
        expect(error.data.code).toBe('REVPARSE_AMBIGUOUS');
        if (error.data.code === 'REVPARSE_AMBIGUOUS') {
          expect(error.data.expression).toBe('twice');
          expect(error.data.candidates.length).toBeGreaterThan(1);
        }
      });
    });

    describe('When git branch --force and tsgit branchCreate with force both cut from it', () => {
      it('Then force changes nothing — the ambiguity is refused before the name is looked at', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('ambiguous-force');
        git(dir, 'branch', 'twice', commitId);
        git(dir, 'tag', 'twice', commitId);

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          dir,
          'branch',
          '--force',
          'b-forced-git',
          'twice',
        ]);
        const error = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b-forced-tsgit', startPoint: 'twice', force: true }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(
          "warning: refname 'twice' is ambiguous.\nfatal: ambiguous object name: 'twice'\n",
        );
        expect(error.data.code).toBe('REVPARSE_AMBIGUOUS');
        if (error.data.code === 'REVPARSE_AMBIGUOUS') {
          expect(error.data.expression).toBe('twice');
        }
      });
    });

    describe('When git tag and tsgit tagCreate both cut from it', () => {
      it('Then both take it without refusing — only branch checks the count', async () => {
        // Arrange — the same short name as a branch AND a tag.
        const { dir, ctx } = await caseRepo('tag-over-ambiguous');
        git(dir, 'branch', 'twice', commitId);
        git(dir, 'tag', 'twice', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'tag', 't-amb-git', 'twice']);
        const result = await tagCreate(ctx, { name: 't-amb-tsgit', target: 'twice' });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(git(dir, 'rev-parse', 'refs/tags/t-amb-git').trim()).toBe(commitId);
        expect(result.id).toBe(commitId);
        expect(git(dir, 'rev-parse', 'refs/tags/t-amb-tsgit').trim()).toBe(
          git(dir, 'rev-parse', 'refs/tags/t-amb-git').trim(),
        );
      });
    });
  });

  describe('Given a branch literally named HEAD alongside the pseudo-ref', () => {
    describe('When git branch and tsgit branchCreate both pass HEAD as the start point', () => {
      it('Then both refuse — the literal HEAD now names two things', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('head-ambiguous');
        git(dir, 'update-ref', 'refs/heads/HEAD', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-head-git', 'HEAD']);
        const error = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b-head-tsgit', startPoint: 'HEAD' }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(
          "warning: refname 'HEAD' is ambiguous.\nfatal: ambiguous object name: 'HEAD'\n",
        );
        expect(error.data.code).toBe('REVPARSE_AMBIGUOUS');
        if (error.data.code === 'REVPARSE_AMBIGUOUS') {
          expect(error.data.expression).toBe('HEAD');
        }
      });
    });

    describe('When git branch and tsgit branchCreate both omit the start point', () => {
      it('Then both accept — the omitted default never goes through the ladder', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('head-ambiguous-omitted');
        git(dir, 'update-ref', 'refs/heads/HEAD', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b-default-git']);
        const result = await branchCreate(ctx, { name: 'b-default-tsgit' });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toBe('');
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a startPoint that resolves to a commit', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both succeed and land on the same oid', async () => {
        // Arrange + Act
        const { dir, ctx } = await caseRepo('commit');
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b1-git', commitId]);
        const result = await branchCreate(ctx, { name: 'b1-tsgit', startPoint: commitId });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a startPoint that resolves to a tree, by full oid', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse with exit 128 and the reconstructed lines match git byte-for-byte', async () => {
        // Arrange + Act
        const { dir, ctx } = await caseRepo('tree-oid');
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b2-git', treeId]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b2-tsgit', startPoint: treeId }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(err.data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: treeId,
        });
        expect(gitResult.stderr).toBe(errorLine(treeId, 'tree') + fatalLine(treeId));
      });
    });
  });

  describe('Given a startPoint that resolves to a blob, by full oid', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse with exit 128 and the reconstructed lines match git byte-for-byte', async () => {
        // Arrange + Act
        const { dir, ctx } = await caseRepo('blob-oid');
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b3-git', blobId]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b3-tsgit', startPoint: blobId }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(err.data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'blob',
          id: blobId,
        });
        expect(gitResult.stderr).toBe(errorLine(blobId, 'blob') + fatalLine(blobId));
      });
    });
  });

  describe('Given a startPoint naming an annotated tag over a commit', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both peel to the commit, never landing on the tag object', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('tag-to-commit');
        const startPoint = 'refs/tags/tag-to-commit';

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b4-git', startPoint]);
        const result = await branchCreate(ctx, { name: 'b4-tsgit', startPoint });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        const gitPeeled = git(dir, 'rev-parse', `${startPoint}^{commit}`).trim();
        expect(gitPeeled).toBe(commitId);
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a startPoint naming an annotated tag over a tree', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse — the reported oid is the tag object, not its target', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('tag-to-tree');
        const startPoint = 'refs/tags/tag-to-tree';

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b5-git', startPoint]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b5-tsgit', startPoint }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        const tagOid = git(dir, 'rev-parse', startPoint).trim();
        expect(err.data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: tagOid,
        });
        expect(gitResult.stderr).toBe(errorLine(tagOid, 'tree') + fatalLine(startPoint));
      });
    });
  });

  describe('Given a startPoint naming a lightweight tag over a tree', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse — the reported oid is the tree the ref points at directly', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('light-to-tree');
        const startPoint = 'refs/tags/light-to-tree';

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b6-git', startPoint]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b6-tsgit', startPoint }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(err.data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'tree',
          id: treeId,
        });
        expect(gitResult.stderr).toBe(errorLine(treeId, 'tree') + fatalLine(startPoint));
      });
    });
  });

  describe('Given an unresolvable startPoint on a fresh branch name', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse with exit 128, on a different refusal than the typing check', async () => {
        // Arrange + Act
        const { dir, ctx } = await caseRepo('unresolvable');
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'b7-git', 'nope-xyz']);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b7-tsgit', startPoint: 'nope-xyz' }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain("fatal: not a valid object name: 'nope-xyz'");
        expect(err.data.code).toBe('BRANCH_NOT_FOUND');
      });
    });
  });

  describe('Given an invalid branch name', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse before the start point is ever looked at', async () => {
        // Arrange + Act — a start point that would itself refuse (a tree oid)
        // proves the name check runs first: if it ran second the refusal
        // would report UNEXPECTED_OBJECT_TYPE instead of an invalid name.
        const { dir, ctx } = await caseRepo('invalid-name');
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'bad..name', treeId]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'bad..name', startPoint: treeId }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain("'bad..name' is not a valid branch name");
        expect(err.data.code).toBe('INVALID_REF');
      });
    });
  });

  describe('Given an existing branch name and an unresolvable startPoint', () => {
    describe('When git branch and tsgit branchCreate both run without force', () => {
      it('Then both refuse as already-exists, before the start point ever resolves', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('exists-unresolvable');
        git(dir, 'branch', 'side-git', commitId);
        await branchCreate(ctx, { name: 'side-tsgit', startPoint: commitId });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'side-git', 'nope-xyz']);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'side-tsgit', startPoint: 'nope-xyz' }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain("fatal: a branch named 'side-git' already exists");
        expect(err.data.code).toBe('BRANCH_EXISTS');
      });
    });
  });

  describe('Given an existing branch name and a non-commit startPoint', () => {
    describe('When git branch and tsgit branchCreate both run without force', () => {
      it('Then both refuse as already-exists — the exists check precedes typing too', async () => {
        // Arrange
        const { dir, ctx } = await caseRepo('exists-non-commit');
        git(dir, 'branch', 'side2-git', commitId);
        await branchCreate(ctx, { name: 'side2-tsgit', startPoint: commitId });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'branch', 'side2-git', treeId]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'side2-tsgit', startPoint: treeId }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain("fatal: a branch named 'side2-git' already exists");
        expect(err.data.code).toBe('BRANCH_EXISTS');
      });
    });
  });
});

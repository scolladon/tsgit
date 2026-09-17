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
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchCreate } from '../../src/application/commands/branch.js';
import { tagCreate } from '../../src/application/commands/tag.js';
import { TsgitError } from '../../src/domain/error.js';
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
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-start-point-${slug}-`));
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

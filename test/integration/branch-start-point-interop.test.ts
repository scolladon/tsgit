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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchCreate } from '../../src/application/commands/branch.js';
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
  let pair: PeerPair;
  let ctx: Context;
  let commitId: string;
  let treeId: string;
  let blobId: string;

  beforeAll(async () => {
    pair = await makePeerPair('branch-start-point');
    initBothRepos(pair.peer, pair.ours);
    disableAutoMaintenance(pair.ours);
    git(pair.ours, 'commit', '-q', '--allow-empty', '-m', 'root');
    commitId = git(pair.ours, 'rev-parse', 'HEAD').trim();
    treeId = git(pair.ours, 'write-tree').trim();
    blobId = git(pair.ours, 'hash-object', '-w', '--stdin').trim();
    git(pair.ours, 'tag', 'light-to-tree', treeId);
    git(pair.ours, 'tag', '-a', 'tag-to-tree', '-m', 'tag-to-tree', treeId);
    git(pair.ours, 'tag', '-a', 'tag-to-commit', '-m', 'tag-to-commit', commitId);
    // A fresh Context only after every git-side write above — reading through
    // a Context created earlier could see a session cache populated before
    // the fixture existed.
    ctx = createNodeContext({ workDir: pair.ours });
  }, 60_000);

  afterAll(async () => {
    await pair.dispose();
  });

  describe('Given a bare name only one namespace carries', () => {
    describe('When git branch and tsgit branchCreate both cut from it', () => {
      it('Then both land on the same oid', async () => {
        // Arrange — a tag-only short name, which git expands through its
        // revision ladder rather than reading verbatim.
        git(pair.ours, 'tag', 'ladder-tag', commitId);

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          pair.ours,
          'branch',
          'b-ladder-git',
          'ladder-tag',
        ]);
        const result = await branchCreate(ctx, {
          name: 'b-ladder-tsgit',
          startPoint: 'ladder-tag',
        });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.id).toBe(commitId);
        expect(git(pair.ours, 'rev-parse', 'refs/heads/b-ladder-git').trim()).toBe(result.id);
      });
    });
  });

  describe('Given a bare name two namespaces carry', () => {
    describe('When git branch and tsgit branchCreate both cut from it', () => {
      it('Then both refuse, naming the expression as ambiguous', async () => {
        // Arrange — the same short name as a branch AND a tag.
        git(pair.ours, 'branch', 'twice', commitId);
        git(pair.ours, 'tag', 'twice', commitId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b-amb-git', 'twice']);
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

    describe('When a tag is created over that same name on both sides', () => {
      it('Then both take it without refusing — only branch checks the count', async () => {
        // Arrange + Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'tag', 't-amb-git', 'twice']);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(git(pair.ours, 'rev-parse', 'refs/tags/t-amb-git').trim()).toBe(commitId);
      });
    });
  });

  describe('Given a startPoint that resolves to a commit', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both succeed and land on the same oid', async () => {
        // Arrange + Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b1-git', commitId]);
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
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b2-git', treeId]);
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
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b3-git', blobId]);
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
        const startPoint = 'refs/tags/tag-to-commit';

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b4-git', startPoint]);
        const result = await branchCreate(ctx, { name: 'b4-tsgit', startPoint });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        const gitPeeled = git(pair.ours, 'rev-parse', `${startPoint}^{commit}`).trim();
        expect(gitPeeled).toBe(commitId);
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a startPoint naming an annotated tag over a tree', () => {
    describe('When git branch and tsgit branchCreate both run', () => {
      it('Then both refuse — the reported oid is the tag object, not its target', async () => {
        // Arrange
        const startPoint = 'refs/tags/tag-to-tree';

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b5-git', startPoint]);
        const err = await catchTsgitError(() =>
          branchCreate(ctx, { name: 'b5-tsgit', startPoint }),
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        const tagOid = git(pair.ours, 'rev-parse', startPoint).trim();
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
        const startPoint = 'refs/tags/light-to-tree';

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b6-git', startPoint]);
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
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'b7-git', 'nope-xyz']);
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
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'bad..name', treeId]);
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
        git(pair.ours, 'branch', 'side-git', commitId);
        await branchCreate(ctx, { name: 'side-tsgit', startPoint: commitId });

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'side-git', 'nope-xyz']);
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
        git(pair.ours, 'branch', 'side2-git', commitId);
        await branchCreate(ctx, { name: 'side2-tsgit', startPoint: commitId });

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.ours, 'branch', 'side2-git', treeId]);
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

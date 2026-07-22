import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { computePatchId } from '../../../../src/application/primitives/patch-id.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const encoder = new TextEncoder();

/** Build a commit that introduces a gitlink at path `sub` with `gitlinkOid`. */
const commitGitlink = async (
  ctx: Context,
  gitlinkOid: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const tree = await writeTree(ctx, [{ mode: FILE_MODE.GITLINK, name: 'sub', id: gitlinkOid }]);
  return createCommit(ctx, {
    tree,
    parents: [...parents],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'c',
  });
};

/** Build a commit whose single file `f` holds `content`, on `parents`. */
const commitFile = async (
  ctx: Context,
  content: string,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: encoder.encode(content),
  });
  const tree = await writeTree(ctx, [{ mode: FILE_MODE.REGULAR, name: 'f', id: blob }]);
  return createCommit(ctx, {
    tree,
    parents: [...parents],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'c',
  });
};

/** Build a commit whose single file lives at `dir/f` (one level of nesting). */
const commitNestedFile = async (
  ctx: Context,
  content: string,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: encoder.encode(content),
  });
  const subtree = await writeTree(ctx, [{ mode: FILE_MODE.REGULAR, name: 'f', id: blob }]);
  const tree = await writeTree(ctx, [{ mode: FILE_MODE.DIRECTORY, name: 'dir', id: subtree }]);
  return createCommit(ctx, {
    tree,
    parents: [...parents],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'c',
  });
};

describe('computePatchId', () => {
  describe('Given the same change with identical context at different line offsets, When patch-ids are computed', () => {
    it('Then the patch-ids are equal (hunk line numbers are ignored)', async () => {
      // Arrange — both change `target` -> CHANGED with the SAME 3-line context
      // (c1/c2/c3 above, d1/d2/d3 below); the second is pushed four lines lower by
      // padding that sits OUTSIDE the context window, so only the @@ offset differs.
      const ctx = await buildSeededContext();
      const baseA = await commitFile(ctx, 'c1\nc2\nc3\ntarget\nd1\nd2\nd3\n', []);
      const cA = await commitFile(ctx, 'c1\nc2\nc3\nCHANGED\nd1\nd2\nd3\n', [baseA]);
      const baseB = await commitFile(ctx, 'p1\np2\np3\np4\nc1\nc2\nc3\ntarget\nd1\nd2\nd3\n', []);
      const cB = await commitFile(ctx, 'p1\np2\np3\np4\nc1\nc2\nc3\nCHANGED\nd1\nd2\nd3\n', [
        baseB,
      ]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).toBe(other);
    });
  });

  describe('Given two commits introducing different changes, When patch-ids are computed', () => {
    it('Then the patch-ids differ', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const base = await commitFile(ctx, 'l1\nl2\nl3\n', []);
      const cA = await commitFile(ctx, 'l1\nCHANGED\nl3\n', [base]);
      const cB = await commitFile(ctx, 'l1\nOTHER\nl3\n', [base]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).not.toBe(other);
    });
  });

  describe('Given the same logical change, When the patch-id is recomputed', () => {
    it('Then recomputing yields a stable, identical id', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const base = await commitFile(ctx, 'a\nb\n', []);
      const c = await commitFile(ctx, 'a\nb\nc\n', [base]);

      // Act
      const first = await computePatchId(ctx, c);
      const second = await computePatchId(ctx, c);

      // Assert
      expect(first).toBe(second);
    });
  });

  describe('Given a commit that changes a file inside a sub-directory, When the patch-id is computed', () => {
    it('Then it is a stable, computable id (the nested diff recurses)', async () => {
      // Arrange — previously threw UNEXPECTED_OBJECT_TYPE: the non-recursive
      // diff surfaced `dir` as a tree-oid change that materialise then readBlob'd.
      const ctx = await buildSeededContext();
      const base = await commitNestedFile(ctx, 'a\nb\n', []);
      const c = await commitNestedFile(ctx, 'a\nb\nc\n', [base]);

      // Act
      const first = await computePatchId(ctx, c);
      const second = await computePatchId(ctx, c);

      // Assert
      expect(first).toMatch(/^[0-9a-f]+$/);
      expect(first).toBe(second);
    });
  });

  describe('Given the same nested change on two different bases, When patch-ids are computed', () => {
    it('Then the patch-ids are equal (recursion preserves equivalence)', async () => {
      // Arrange — identical `dir/f` edit, pushed to different line offsets by
      // out-of-context padding; only the @@ offset differs, so ids must collide.
      const ctx = await buildSeededContext();
      const baseA = await commitNestedFile(ctx, 'c1\nc2\nc3\ntarget\nd1\nd2\nd3\n', []);
      const cA = await commitNestedFile(ctx, 'c1\nc2\nc3\nCHANGED\nd1\nd2\nd3\n', [baseA]);
      const baseB = await commitNestedFile(
        ctx,
        'p1\np2\np3\np4\nc1\nc2\nc3\ntarget\nd1\nd2\nd3\n',
        [],
      );
      const cB = await commitNestedFile(ctx, 'p1\np2\np3\np4\nc1\nc2\nc3\nCHANGED\nd1\nd2\nd3\n', [
        baseB,
      ]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).toBe(other);
    });
  });

  describe('Given a root commit (no parent), When the patch-id is computed', () => {
    it('Then the patch-id is computed against the empty tree', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const root = await commitFile(ctx, 'hello\n', []);
      const rootOther = await commitFile(ctx, 'goodbye\n', []);

      // Act
      const sut = await computePatchId(ctx, root);

      // Assert — a non-empty hex digest, distinct from a different root's
      expect(sut).toMatch(/^[0-9a-f]+$/);
      expect(sut).not.toBe(await computePatchId(ctx, rootOther));
    });
  });

  describe('Given two commits introducing the same submodule pointer, When patch-ids are computed', () => {
    it('Then the patch-ids are equal (Subproject commit line is stable in the equivalence key)', async () => {
      // Arrange — both commits introduce the same gitlink oid at path `sub`
      // on top of the same empty-tree base; the gitlink oid need not exist as
      // a real object because materialiseOne synthesizes without reading it.
      const ctx = await buildSeededContext();
      const base = await commitFile(ctx, 'seed\n', []);
      // Use a fixed arbitrary gitlink oid (40 hex chars); writeTree accepts
      // without validating the target object exists.
      const gitlinkOid = '1'.repeat(40) as ObjectId;
      const cA = await commitGitlink(ctx, gitlinkOid, [base]);
      const cB = await commitGitlink(ctx, gitlinkOid, [base]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert — same pointer → same patch-id
      expect(sut).toBe(other);
    });
  });

  describe('Given two commits introducing different submodule pointers, When patch-ids are computed', () => {
    it('Then the patch-ids differ (oid-bearing Subproject commit line distinguishes them)', async () => {
      // Arrange — two different gitlink oids; both commits are otherwise
      // identical (same base, same path `sub`).
      const ctx = await buildSeededContext();
      const base = await commitFile(ctx, 'seed\n', []);
      const gitlinkOidA = '1'.repeat(40) as ObjectId;
      const gitlinkOidB = '2'.repeat(40) as ObjectId;
      const cA = await commitGitlink(ctx, gitlinkOidA, [base]);
      const cB = await commitGitlink(ctx, gitlinkOidB, [base]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert — different pointers → different patch-ids
      expect(sut).not.toBe(other);
    });
  });

  describe('Given two root commits that add the same path with different binary content, When patch-ids are computed', () => {
    it('Then the patch-ids differ (the blob oids fold into the binary equivalence key)', async () => {
      // Arrange — identical path `f`, both binary (a NUL byte); the rendered patch is
      // just "Binary files … differ" for both, so only the folded oid distinguishes them.
      const ctx = await buildSeededContext();
      const cA = await commitFile(ctx, 'BIN\0AAAA', []);
      const cB = await commitFile(ctx, 'BIN\0BBBB', []);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).not.toBe(other);
    });
  });

  describe('Given two root commits that add the same path with identical binary content, When patch-ids are computed', () => {
    it('Then the patch-ids are equal (identical binary content folds to the same key)', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const cA = await commitFile(ctx, 'BIN\0SAME', []);
      const cB = await commitFile(ctx, 'BIN\0SAME', []);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).toBe(other);
    });
  });

  describe('Given two commits that modify a binary file to different content on the same base, When patch-ids are computed', () => {
    it('Then the patch-ids differ (the new blob oid folds into the key)', async () => {
      // Arrange — a shared binary base, then divergent binary content; the rendered
      // patch is identical ("Binary files … differ"), so only the new oid distinguishes.
      const ctx = await buildSeededContext();
      const base = await commitFile(ctx, 'BIN\0BASE', []);
      const cA = await commitFile(ctx, 'BIN\0AAAA', [base]);
      const cB = await commitFile(ctx, 'BIN\0BBBB', [base]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).not.toBe(other);
    });
  });

  describe('Given two commits whose diffs differ only by intra-line whitespace, When patch-ids are computed', () => {
    it('Then the patch-ids are equal (intra-line whitespace is stripped from the key)', async () => {
      // Arrange — same base, then the changed line differs only in the run of spaces.
      const ctx = await buildSeededContext();
      const base = await commitFile(ctx, 'x\n', []);
      const cA = await commitFile(ctx, 'x y\n', [base]);
      const cB = await commitFile(ctx, 'x  y\n', [base]);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).toBe(other);
    });
  });

  describe('Given two root commits whose added content is identical apart from line boundaries, When patch-ids are computed', () => {
    it('Then the patch-ids are equal (the canonical key concatenates whitespace-stripped lines)', async () => {
      // Arrange — one add carries `b+c` on a single line, the other splits it across
      // two lines; stripping whitespace then concatenating collapses both to one key.
      const ctx = await buildSeededContext();
      const cA = await commitFile(ctx, 'b+c\n', []);
      const cB = await commitFile(ctx, 'b\nc\n', []);

      // Act
      const sut = await computePatchId(ctx, cA);
      const other = await computePatchId(ctx, cB);

      // Assert
      expect(sut).toBe(other);
    });
  });

  describe('Given ctx.command is wired and a textconv driver is configured, When patch-id is computed', () => {
    it('Then the patch-id uses raw blob bytes — textconv does not affect the equivalence key', async () => {
      // Arrange — ctx with command runner (simulates real Node.js context);
      // a textconv driver is configured; two commits introduce the same change
      // to the same file; patch-ids must match regardless of textconv output.
      let runnerCallCount = 0;
      const ctx = createMemoryContext({
        command: {
          run: async () => {
            runnerCallCount++;
            return { exitCode: 0, stdout: encoder.encode('TRANSFORMED\n') };
          },
        },
      });
      // Write textconv config into the memory context's gitDir
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f diff=upper\n');
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
      );
      const base = await commitFile(ctx, 'before\n', []);
      const cA = await commitFile(ctx, 'after\n', [base]);
      const cB = await commitFile(ctx, 'after\n', [base]);

      // Act
      const patchIdA = await computePatchId(ctx, cA);
      const patchIdB = await computePatchId(ctx, cB);

      // Assert — patch-ids are equal (same logical change) and textconv was NOT invoked
      expect(patchIdA).toBe(patchIdB);
      expect(runnerCallCount).toBe(0);
    });
  });
});

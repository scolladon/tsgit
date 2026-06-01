import { describe, expect, it } from 'vitest';
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
});

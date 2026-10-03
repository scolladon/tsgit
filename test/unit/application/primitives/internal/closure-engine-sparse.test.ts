import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { computeClosure } from '../../../../../src/application/primitives/internal/closure-engine.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR = { name: 'A', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };

const blob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: new TextEncoder().encode(text) });

const commit = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: AUTHOR, committer: AUTHOR, message: 'c\n', extraHeaders: [] },
  });

interface RenamedDirectory {
  readonly ctx: Context;
  readonly upstream: ObjectId;
  readonly head: ObjectId;
  /** `x/`, held under `d/` upstream and moved under `e/` by head. */
  readonly moved: ObjectId;
  readonly movedBlob: ObjectId;
}

/** Upstream holds `d/x/a`; head moves `x/` under `e/` beside a new `y`. */
const renamedDirectory = async (): Promise<RenamedDirectory> => {
  const ctx = createMemoryContext();
  const movedBlob = await blob(ctx, 'a\n');
  const moved = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', movedBlob)]);
  const underD = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'x', moved)]);
  const upstream = await commit(
    ctx,
    await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'd', underD)]),
    [],
  );
  const underE = await writeTree(ctx, [
    treeEntry(FILE_MODE.DIRECTORY, 'x', moved),
    treeEntry(FILE_MODE.REGULAR, 'y', await blob(ctx, 'y\n')),
  ]);
  const head = await commit(
    ctx,
    await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'e', underE)]),
    [upstream],
  );
  return { ctx, upstream, head, moved, movedBlob };
};

describe('Given a head that moves a directory its upstream holds', () => {
  describe('When the closure marks the excluded side sparsely', () => {
    it('Then the moved directory and its contents stay in the closure, as git sparse marking leaves them', async () => {
      // Arrange
      const { ctx, upstream, head, moved, movedBlob } = await renamedDirectory();
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        wants: [head],
        not: [upstream],
        objects: true,
        tier: 'walk',
        sparse: true,
      });

      // Assert
      const ids = result.objects.map((object) => object.id);
      expect(ids).toContain(moved);
      expect(ids).toContain(movedBlob);
      expect(ids).toHaveLength(6);
    });
  });

  describe('When the closure marks the excluded side densely', () => {
    it('Then every object the upstream tree reaches is excluded', async () => {
      // Arrange
      const { ctx, upstream, head, moved, movedBlob } = await renamedDirectory();
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        wants: [head],
        not: [upstream],
        objects: true,
        tier: 'walk',
      });

      // Assert
      const ids = result.objects.map((object) => object.id);
      expect(ids).not.toContain(moved);
      expect(ids).not.toContain(movedBlob);
      expect(ids).toHaveLength(4);
    });
  });
});

describe('Given a head that renames a file its upstream holds at the root', () => {
  describe('When the closure marks the excluded side sparsely', () => {
    it('Then the file stays excluded, as a child of an excluded tree is marked whatever its path', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const kept = await blob(ctx, 'k\n');
      const upstream = await commit(
        ctx,
        await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', kept)]),
        [],
      );
      const head = await commit(
        ctx,
        await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'b', kept)]),
        [upstream],
      );
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        wants: [head],
        not: [upstream],
        objects: true,
        tier: 'walk',
        sparse: true,
      });

      // Assert
      expect(result.objects.map((object) => object.id)).not.toContain(kept);
    });
  });
});

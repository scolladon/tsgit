/**
 * A malformed `core.bigFileThreshold` (last entry wins) under `diffTrees`:
 * git reads it when it weighs a blob's content for binary-ness — the stat
 * output and the whitespace-aware drop pass — never for a tree-only diff, a
 * gitlink, or a path whose attributes already settle binary-ness.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { diffTrees } from '../../../../src/application/primitives/diff-trees.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

const REGULAR = '100644' as FileMode;
const GITLINK = '160000' as FileMode;
const SUBMODULE_COMMIT = '1'.repeat(40) as ObjectId;

const malformedRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbigFileThreshold = x\n');
  invalidateConfigCache(ctx);
  return ctx;
};

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(content),
  });

/** Two one-entry trees whose `name` entry changes from `a` to `b`. */
const modifiedPair = async (ctx: Context, name: string): Promise<readonly [ObjectId, ObjectId]> => [
  await writeTree(ctx, [treeEntry(REGULAR, name, await blob(ctx, 'a\n'))]),
  await writeTree(ctx, [treeEntry(REGULAR, name, await blob(ctx, 'b\n'))]),
];

const refusalOf = (op: Promise<unknown>): Promise<unknown> =>
  op.then(
    () => undefined,
    (err: { data: unknown }) => err.data,
  );

const REFUSAL = { code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'core.bigfilethreshold', value: 'x' };

describe('Given a malformed core.bigFileThreshold and a modified blob', () => {
  describe('When diffing with stat', () => {
    it('Then it refuses with the key', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const [from, to] = await modifiedPair(ctx, 'a.txt');
      const sut = diffTrees;

      // Act
      const result = await refusalOf(sut(ctx, from, to, { withStat: true }));

      // Assert
      expect(result).toMatchObject(REFUSAL);
    });
  });

  describe('When diffing ignoring whitespace', () => {
    it('Then it refuses with the key', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const [from, to] = await modifiedPair(ctx, 'a.txt');
      const sut = diffTrees;

      // Act
      const result = await refusalOf(sut(ctx, from, to, { ignoreWhitespace: 'all' }));

      // Assert
      expect(result).toMatchObject(REFUSAL);
    });
  });

  describe('When diffing the trees alone', () => {
    it('Then it diffs without reading the threshold', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const [from, to] = await modifiedPair(ctx, 'a.txt');
      const sut = diffTrees;

      // Act
      const result = await sut(ctx, from, to);

      // Assert
      expect(result.changes).toHaveLength(1);
    });
  });
});

describe('Given a malformed core.bigFileThreshold and an added gitlink', () => {
  describe('When diffing with stat', () => {
    it('Then it diffs without reading the threshold', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const from = await writeTree(ctx, []);
      const to = await writeTree(ctx, [treeEntry(GITLINK, 'sub', SUBMODULE_COMMIT)]);
      const sut = diffTrees;

      // Act
      const result = await sut(ctx, from, to, { withStat: true });

      // Assert
      expect(result.changes).toHaveLength(1);
    });
  });
});

describe('Given a malformed core.bigFileThreshold and a blob its attributes call binary', () => {
  describe('When diffing with stat', () => {
    it('Then it diffs without reading the threshold', async () => {
      // Arrange
      const ctx = await malformedRepo();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/attributes`, '*.bin binary\n');
      const [from, to] = await modifiedPair(ctx, 'a.bin');
      const sut = diffTrees;

      // Act
      const result = await sut(ctx, from, to, { withStat: true });

      // Assert
      expect(result.changes).toHaveLength(1);
    });
  });
});

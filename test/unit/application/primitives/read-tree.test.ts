import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readTree } from '../../../../src/application/primitives/read-tree.js';
import { MAX_PEEL_DEPTH } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Blob,
  ObjectId,
  RefName,
  Tag,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'alice@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

describe('readTree', () => {
  it('Given a tree id, When readTree is called, Then returns the Tree', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const id = await writeObject(ctx, tree);
    const sut = await readTree(ctx, id);
    // Assert
    expect(sut.type).toBe('tree');
  });

  it('Given a commit id, When readTree is called, Then peels to the commit.tree', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const commitId = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'm',
    });
    const sut = await readTree(ctx, commitId);
    // Assert
    expect(sut.id).toBe(treeId);
  });

  it('Given HEAD as ref, When readTree is called, Then resolves HEAD → peels commit → tree', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const commitId = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'm',
    });
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/main', `${commitId}\n`);
    await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    const sut = await readTree(ctx, 'HEAD' as RefName);
    // Assert
    expect(sut.id).toBe(treeId);
  });

  it('Given a tag chain at exactly MAX_PEEL_DEPTH (at cap), When readTree is called, Then succeeds', async () => {
    // Kills the `depth > MAX_PEEL_DEPTH` EqualityOperator `>=` mutant: under
    // `>=`, depth=5 would trip the guard; under `>`, it's the threshold that
    // still succeeds.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    let currentId: ObjectId = treeId;
    let currentType: 'tree' | 'tag' = 'tree';
    // Build exactly MAX_PEEL_DEPTH tags (5), so peel walker hits depth == 5
    // after the final hop and must still succeed.
    for (let i = 0; i < MAX_PEEL_DEPTH; i += 1) {
      const tag: Tag = {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: currentId,
          objectType: currentType,
          tagName: `ok${i}`,
          tagger: AUTHOR,
          message: `t${i}`,
          extraHeaders: [],
        },
      };
      currentId = await writeObject(ctx, tag);
      currentType = 'tag';
    }
    const sut = await readTree(ctx, currentId);
    expect(sut.type).toBe('tree');
    expect(sut.id).toBe(treeId);
  });

  it('Given a tag chain exceeding MAX_PEEL_DEPTH, When readTree is called, Then throws REF_CHAIN_TOO_DEEP', async () => {
    // Arrange — create MAX_PEEL_DEPTH+1 tags pointing at each other. The peel
    // walker depth counter is the only thing stopping runaway resolution.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    let currentId: ObjectId = treeId;
    let currentType: 'tree' | 'tag' = 'tree';
    for (let i = 0; i <= MAX_PEEL_DEPTH; i += 1) {
      const tag: Tag = {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: currentId,
          objectType: currentType,
          tagName: `v${i}`,
          tagger: AUTHOR,
          message: `tag${i}`,
          extraHeaders: [],
        },
      };
      currentId = await writeObject(ctx, tag);
      currentType = 'tag';
    }

    // Act / Assert
    try {
      await readTree(ctx, currentId);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_CHAIN_TOO_DEEP');
    }
  });

  it('Given a blob id, When readTree is called, Then throws UNEXPECTED_OBJECT_TYPE', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
    const id = await writeObject(ctx, blob);
    try {
      await readTree(ctx, id);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('UNEXPECTED_OBJECT_TYPE');
    }
  });
});

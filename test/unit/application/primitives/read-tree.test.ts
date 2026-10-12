import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readTree } from '../../../../src/application/primitives/read-tree.js';
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
import { buildSeededContext, writeForgedTagLoop } from './fixtures.js';

const DEEP_TAG_CHAIN = 6;

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'alice@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

describe('readTree', () => {
  describe('Given a tree id', () => {
    describe('When readTree is called', () => {
      it('Then returns the Tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const id = await writeObject(ctx, tree);

        // Act
        const result = await readTree(ctx, id);

        // Assert
        expect(result.type).toBe('tree');
      });
    });
  });

  describe('Given a commit id', () => {
    describe('When readTree is called', () => {
      it('Then peels to the commit.tree', async () => {
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

        // Act
        const result = await readTree(ctx, commitId);

        // Assert
        expect(result.id).toBe(treeId);
      });
    });
  });

  describe('Given HEAD as ref', () => {
    describe('When readTree is called', () => {
      it('Then resolves HEAD → peels commit → tree', async () => {
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

        // Act
        const result = await readTree(ctx, 'HEAD' as RefName);

        // Assert
        expect(result.id).toBe(treeId);
      });
    });
  });

  describe('Given a tag chain deeper than any cap', () => {
    describe('When readTree is called', () => {
      it('Then it peels every tag to the tree, as git does', async () => {
        // Arrange — six tags, each naming the previous one.
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, tree);
        let currentId: ObjectId = treeId;
        let currentType: 'tree' | 'tag' = 'tree';
        for (let i = 0; i < DEEP_TAG_CHAIN; i += 1) {
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

        const sut = readTree;

        // Act
        const result = await sut(ctx, currentId);

        // Assert
        expect(result.id).toBe(treeId);
      });
    });
  });

  describe('Given a forged tag naming itself', () => {
    describe('When readTree is called', () => {
      it('Then it refuses the looping chain with REF_CHAIN_TOO_DEEP', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const loop = await writeForgedTagLoop(ctx);
        const sut = readTree;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, loop);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toMatchObject({ code: 'REF_CHAIN_TOO_DEEP', depth: 1 });
      });
    });
  });

  describe('Given a blob id', () => {
    describe('When readTree is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
        const id = await writeObject(ctx, blob);

        // Act + Assert
        try {
          await readTree(ctx, id);
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        }
      });
    });
  });
});

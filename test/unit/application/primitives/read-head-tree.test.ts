import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { readHeadTree } from '../../../../src/application/primitives/read-head-tree.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('readHeadTree', () => {
  describe('Given an unborn HEAD (no commits yet)', () => {
    describe('When readHeadTree runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        const sut = await readHeadTree(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a committed HEAD with a nested tree', () => {
    describe('When readHeadTree runs', () => {
      it('Then it returns a FlatTree of leaf blobs keyed by full path', async () => {
        // Arrange — src/a.txt + b.txt committed; the `src` directory entry must be
        // flattened away, leaving only the two leaf blobs.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['src/a.txt', 'b.txt']);
        await commit(ctx, { message: 'first', author });

        // Act
        const sut = await readHeadTree(ctx);

        // Assert — exactly the two leaves, full-path keyed, regular mode, no `src`.
        expect(sut?.entries.size).toBe(2);
        expect(sut?.entries.get('a.txt' as FilePath)).toBeUndefined();
        expect(sut?.entries.get('src' as FilePath)).toBeUndefined();
        const leaf = sut?.entries.get('src/a.txt' as FilePath);
        expect(leaf?.mode).toBe(FILE_MODE.REGULAR);
        expect(leaf?.id).toMatch(/^[0-9a-f]{40}$/);
        expect(sut?.entries.get('b.txt' as FilePath)?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given HEAD resolving to a non-commit object', () => {
    describe('When readHeadTree runs', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE with expected=commit', async () => {
        // Arrange — point refs/heads/main at the committed tree oid (a real object,
        // but a tree, not a commit), so resolveRef('HEAD') peels to a non-commit.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        const ref = head.replace('ref: ', '').trim();
        const commitOid = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${ref}`)).trim();
        const commitObj = await readObject(ctx, commitOid as ObjectId);
        const treeOid = commitObj.type === 'commit' ? commitObj.data.tree : '';
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${treeOid}\n`);

        // Act / Assert — specific data, not just the class.
        try {
          await readHeadTree(ctx);
          expect.unreachable('readHeadTree should reject a non-commit HEAD');
        } catch (err) {
          expect((err as { data: { code: string } }).data.code).toBe('UNEXPECTED_OBJECT_TYPE');
          expect((err as { data: { expected: string } }).data.expected).toBe('commit');
          expect((err as { data: { actual: string } }).data.actual).toBe('tree');
          expect((err as { data: { id: string } }).data.id).toBe(treeOid);
        }
      });
    });
  });
});

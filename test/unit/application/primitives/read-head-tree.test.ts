import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import * as flattenTreeMod from '../../../../src/application/primitives/flatten-tree.js';
import { readHeadTree } from '../../../../src/application/primitives/read-head-tree.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { seedMaxTreeDepth } from './fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

// `flattenTreeMod.flattenTree` is a module-namespace export shared by every
// test in this describe — Vitest's ESM `vi.spyOn`/`mockRestore` cycle does
// not reliably zero `.mock.calls` between successive spy/restore pairs on
// the same property, so every assertion below counts calls made SINCE a
// captured baseline rather than trusting an absolute total.
function flattenCallsSince(spy: ReturnType<typeof vi.spyOn>, baseline: number): number {
  return spy.mock.calls.length - baseline;
}

async function commitOneFile(ctx: ReturnType<typeof createMemoryContext>): Promise<void> {
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
}

describe('readHeadTree', () => {
  describe('Given an unborn HEAD (no commits yet)', () => {
    describe('When readHeadTree runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        const result = await readHeadTree(ctx);

        // Assert
        expect(result).toBeUndefined();
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
        const result = await readHeadTree(ctx);

        // Assert — exactly the two leaves, full-path keyed, regular mode, no `src`.
        expect(result?.entries.size).toBe(2);
        expect(result?.entries.get('a.txt' as FilePath)).toBeUndefined();
        expect(result?.entries.get('src' as FilePath)).toBeUndefined();
        const leaf = result?.entries.get('src/a.txt' as FilePath);
        expect(leaf?.mode).toBe(FILE_MODE.REGULAR);
        expect(leaf?.id).toMatch(/^[0-9a-f]{40}$/);
        expect(result?.entries.get('b.txt' as FilePath)?.mode).toBe(FILE_MODE.REGULAR);
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

        // Act + Assert — specific data, not just the class.
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

  describe('Given two status-shaped reads of the same HEAD', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then the tree is flattened once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert
        expect(second).toEqual(first);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(1);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given core.maxTreeDepth changed between two reads', () => {
    describe('When readHeadTree runs before and after the change', () => {
      it('Then the tree is re-flattened', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        await readHeadTree(ctx);
        await seedMaxTreeDepth(ctx, '10');
        await readHeadTree(ctx);

        // Assert — an oid-only key would have served the first read's cached
        // entry here; the depth component in the key forces a fresh flatten.
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given a HEAD tree larger than the byte cap', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then it is not cached and both reads still succeed', async () => {
        // Arrange — a 1-byte deltaCache budget floors the flat-tree cache's
        // own cap below any real FlatTree, so this entry is always over-cap.
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 1 });
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — never cached, so every read re-flattens.
        expect(second).toEqual(first);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given an empty HEAD tree', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then the sizer floors at 1, set does not throw, and the second read hits the cache', async () => {
        // Arrange — a first commit over an untouched index has no parent
        // tree to compare against, so it commits the empty tree, whose
        // per-entry footprint sums to exactly 0.
        const ctx = createMemoryContext();
        await init(ctx);
        await commit(ctx, { message: 'empty', author, allowEmpty: true });
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — no throw reached this line, and the floor kept the entry
        // genuinely cached rather than silently dropping it.
        expect(first?.entries.size).toBe(0);
        expect(second?.entries.size).toBe(0);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(1);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given a HEAD tree containing a gitlink', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then the cached FlatTree still carries the 160000 entry', async () => {
        // Arrange — hand-built tree/commit: a gitlink's target oid is never
        // read by flatten, so any well-formed oid string stands in for a
        // real submodule commit.
        const ctx = createMemoryContext();
        await init(ctx);
        const gitlinkTarget = '1234567890abcdef1234567890abcdef12345678' as ObjectId;
        const treeId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [{ mode: FILE_MODE.GITLINK, name: 'sub', id: gitlinkTarget }],
        });
        const commitId = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'gitlink',
            extraHeaders: [],
          },
        });
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        const ref = head.replace('ref: ', '').trim();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${commitId}\n`);

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — the gitlink entry survives both the raw flatten and the
        // cached return.
        expect(first?.entries.get('sub' as FilePath)).toEqual({
          id: gitlinkTarget,
          mode: FILE_MODE.GITLINK,
        });
        expect(second?.entries.get('sub' as FilePath)).toEqual({
          id: gitlinkTarget,
          mode: FILE_MODE.GITLINK,
        });
      });
    });
  });

  describe('Given HEAD moves between two calls', () => {
    describe('When readHeadTree runs before and after the move', () => {
      it('Then the new tree is flattened', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        const second = await readHeadTree(ctx);

        // Assert
        expect(first?.entries.size).toBe(1);
        expect(second?.entries.size).toBe(2);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });
});

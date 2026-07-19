import { describe, expect, it } from 'vitest';

import { createFsWorkdirEnumerator } from '../../../../../src/adapters/snapshot-resolvers/fs-workdir-enumerator.js';
import { createRawIndexResolver } from '../../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import { createRawTreeResolver } from '../../../../../src/adapters/snapshot-resolvers/raw-tree-resolver.js';
import { createSnapshotFactory } from '../../../../../src/application/primitives/snapshot/snapshot-factory.js';
import { pushStashRef } from '../../../../../src/application/primitives/stash-ref.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type {
  Commit,
  FileMode,
  FilePath,
  ObjectId,
} from '../../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const writeBlob = async (ctx: Context, content: Uint8Array): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content });

const writeTree = async (
  ctx: Context,
  entries: ReadonlyArray<{ name: string; mode: FileMode; id: ObjectId }>,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: entries.map((e) => ({ name: e.name as FilePath, mode: e.mode, id: e.id })),
  });

const writeCommit = async (ctx: Context, treeId: ObjectId): Promise<ObjectId> => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [],
      author: { name: 'a', email: 'b@c', timestamp: 0, timezoneOffset: '+0000' },
      committer: { name: 'a', email: 'b@c', timestamp: 0, timezoneOffset: '+0000' },
      message: 'msg',
      extraHeaders: [],
    },
  };
  return writeObject(ctx, commit);
};

const writeCommitWithParents = async (
  ctx: Context,
  treeId: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [...parents],
      author: { name: 'a', email: 'b@c', timestamp: 0, timezoneOffset: '+0000' },
      committer: { name: 'a', email: 'b@c', timestamp: 0, timezoneOffset: '+0000' },
      message: 'msg',
      extraHeaders: [],
    },
  };
  return writeObject(ctx, commit);
};

const setHead = async (ctx: Context, commitId: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

const factoryFor = (ctx: Context) =>
  createSnapshotFactory({
    ctx,
    indexResolver: createRawIndexResolver(),
    treeResolver: createRawTreeResolver(),
    workdirEnumerator: createFsWorkdirEnumerator(),
  });

describe('createSnapshotFactory', () => {
  describe('Given a repo with HEAD pointing at a commit', () => {
    describe('When sut.head() is iterated', () => {
      it('Then it yields the commit tree leaves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId);
        await setHead(ctx, commitId);
        const sut = factoryFor(ctx);

        // Act
        const rows = await collect(sut.head().entries());

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given an explicit commit oid', () => {
    describe('When sut.commit(oid) is iterated', () => {
      it('Then it resolves the commit and yields its tree leaves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await writeTree(ctx, [
          { name: 'b.txt', mode: FILE_MODE.REGULAR as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId);
        const sut = factoryFor(ctx);

        // Act
        const rows = await collect(sut.commit(commitId).entries());

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['b.txt']);
      });
    });
  });

  describe('Given an explicit tree oid', () => {
    describe('When sut.tree(oid) is iterated', () => {
      it('Then it yields the tree leaves directly without commit-peeling', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, new Uint8Array([42]));
        const treeId = await writeTree(ctx, [
          { name: 'c.txt', mode: FILE_MODE.REGULAR as FileMode, id: blobId },
        ]);
        const sut = factoryFor(ctx);

        // Act
        const rows = await collect(sut.tree(treeId).entries());

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['c.txt']);
      });
    });
  });

  describe('Given a repository with no .git/MERGE_HEAD', () => {
    describe('When sut.mergeHead() is awaited', () => {
      it('Then it resolves to null (no merge in progress)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = factoryFor(ctx);

        // Act
        const result = await sut.mergeHead();

        // Assert
        expect(result).toBeNull();
      });
    });
  });

  describe('Given a repository with a .git/MERGE_HEAD pointing at a commit', () => {
    describe('When sut.mergeHead() is awaited and iterated', () => {
      it('Then it yields the merge-head tree leaves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, new Uint8Array([7]));
        const treeId = await writeTree(ctx, [
          { name: 'm.txt', mode: FILE_MODE.REGULAR as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${commitId}\n`);
        const sut = factoryFor(ctx);

        // Act
        const snapshot = await sut.mergeHead();
        const rows = snapshot === null ? [] : await collect(snapshot.entries());

        // Assert
        expect(snapshot).not.toBeNull();
        expect(rows.map((r) => r.path)).toEqual(['m.txt']);
      });
    });
  });

  describe('Given a tag object pointing at a commit, with MERGE_HEAD pointing at the tag', () => {
    describe('When sut.mergeHead() is iterated', () => {
      it('Then resolveRef peels the tag to the commit (otherwise treeIdFromCommit would reject)', async () => {
        // Arrange — build commit → tag → MERGE_HEAD-points-at-tag chain.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await writeTree(ctx, [
          { name: 't.txt', mode: FILE_MODE.REGULAR as FileMode, id: blobId },
        ]);
        const commitId = await writeCommit(ctx, treeId);
        const tagId = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commitId,
            objectType: 'commit',
            tagName: 'v0',
            tagger: {
              name: 'a',
              email: 'b@c',
              timestamp: 0,
              timezoneOffset: '+0000',
            },
            message: 'tagged',
            extraHeaders: [],
          },
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${tagId}\n`);
        const sut = factoryFor(ctx);

        // Act
        const snapshot = await sut.mergeHead();
        const rows = snapshot === null ? [] : await collect(snapshot.entries());

        // Assert — successful iteration proves peel:true (raw tag-oid path would
        // surface as unexpectedObjectType('commit', 'tag', ...) inside the snapshot).
        expect(snapshot).not.toBeNull();
        expect(rows.map((r) => r.path)).toEqual(['t.txt']);
      });
    });
  });

  describe('Given a MERGE_HEAD symbolic-linked to a ref that does not exist', () => {
    describe('When sut.mergeHead() is awaited', () => {
      it('Then the REF_NOT_FOUND raised inside the try is swallowed to null', async () => {
        // Arrange — the file is present (so the fast-exit is skipped), but it points
        // at a missing ref, so resolveRef raises REF_NOT_FOUND from within the try.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, 'ref: refs/heads/gone\n');
        const sut = factoryFor(ctx);

        // Act
        const result = await sut.mergeHead();

        // Assert — the catch maps the ref-disappeared code to null rather than rethrowing.
        expect(result).toBeNull();
      });
    });
  });

  describe('Given a MERGE_HEAD pointing at a non-commit object (a blob)', () => {
    describe('When sut.mergeHead() is awaited', () => {
      it('Then the UNEXPECTED_OBJECT_TYPE error propagates instead of being swallowed', async () => {
        // Arrange — the ref resolves to a blob oid; peeling it as a commit raises
        // UNEXPECTED_OBJECT_TYPE, a code outside the ref-disappeared set.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, new Uint8Array([9]));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${blobId}\n`);
        const sut = factoryFor(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.mergeHead();
        } catch (err) {
          caught = err;
        }

        // Assert — the catch rethrows any non-ref-disappeared error unchanged.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'commit',
          actual: 'blob',
          id: blobId,
        });
      });
    });
  });

  describe('Given a repo with no stash ref', () => {
    describe('When sut.stashEntry(0) is awaited', () => {
      it('Then it returns null', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = factoryFor(ctx);

        // Act
        const result = await sut.stashEntry(0);

        // Assert
        expect(result).toBeNull();
      });
    });
  });

  describe('Given a tracked-only stash (W with [base, index] parents)', () => {
    describe('When sut.stashEntry(0) is awaited and iterated', () => {
      it('Then the trio exposes the index + workdir trees and untracked is null', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const iBlob = await writeBlob(ctx, new Uint8Array([1]));
        const wBlob = await writeBlob(ctx, new Uint8Array([2]));
        const baseTree = await writeTree(ctx, []);
        const iTree = await writeTree(ctx, [
          { name: 'i.txt', mode: FILE_MODE.REGULAR as FileMode, id: iBlob },
        ]);
        const wTree = await writeTree(ctx, [
          { name: 'w.txt', mode: FILE_MODE.REGULAR as FileMode, id: wBlob },
        ]);
        const b = await writeCommitWithParents(ctx, baseTree, []);
        const i = await writeCommitWithParents(ctx, iTree, [b]);
        const w = await writeCommitWithParents(ctx, wTree, [b, i]);
        await pushStashRef(ctx, w, 'WIP on main: 000 x');
        const sut = factoryFor(ctx);

        // Act
        const entry = await sut.stashEntry(0);

        // Assert
        expect(entry).not.toBeNull();
        if (entry === null) return;
        expect(entry.kind).toBe('stash');
        expect(entry.untracked).toBeNull();
        expect((await collect(entry.index.entries())).map((r) => r.path)).toEqual(['i.txt']);
        expect((await collect(entry.workdir.entries())).map((r) => r.path)).toEqual(['w.txt']);
      });
    });
  });

  describe('Given an include-untracked stash (W with [base, index, untracked] parents)', () => {
    describe('When sut.stashEntry(0) is awaited and iterated', () => {
      it('Then the untracked tree is exposed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const uBlob = await writeBlob(ctx, new Uint8Array([3]));
        const baseTree = await writeTree(ctx, []);
        const uTree = await writeTree(ctx, [
          { name: 'u.txt', mode: FILE_MODE.REGULAR as FileMode, id: uBlob },
        ]);
        const b = await writeCommitWithParents(ctx, baseTree, []);
        const i = await writeCommitWithParents(ctx, baseTree, [b]);
        const u = await writeCommitWithParents(ctx, uTree, []);
        const w = await writeCommitWithParents(ctx, baseTree, [b, i, u]);
        await pushStashRef(ctx, w, 'WIP on main: 000 x');
        const sut = factoryFor(ctx);

        // Act
        const entry = await sut.stashEntry(0);

        // Assert
        expect(entry).not.toBeNull();
        if (entry === null) return;
        expect(entry.untracked).not.toBeNull();
        if (entry.untracked === null) return;
        expect((await collect(entry.untracked.entries())).map((r) => r.path)).toEqual(['u.txt']);
      });
    });
  });

  describe('Given a single-entry stash stack', () => {
    describe('When sut.stashEntry(5) is awaited (out of range)', () => {
      it('Then it returns null', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await writeTree(ctx, []);
        const b = await writeCommitWithParents(ctx, tree, []);
        const w = await writeCommitWithParents(ctx, tree, [b, b]);
        await pushStashRef(ctx, w, 'WIP on main: 000 x');
        const sut = factoryFor(ctx);

        // Act
        const result = await sut.stashEntry(5);

        // Assert
        expect(result).toBeNull();
      });
    });
  });

  describe('Given a two-entry stash stack', () => {
    describe('When sut.stashEntry(1) is awaited (the older entry)', () => {
      it('Then it resolves the older entry, not the newest', async () => {
        // Arrange — newer entry holds `new.txt`, older holds `old.txt`.
        const ctx = await buildSeededContext();
        const oldBlob = await writeBlob(ctx, new Uint8Array([1]));
        const newBlob = await writeBlob(ctx, new Uint8Array([2]));
        const baseTree = await writeTree(ctx, []);
        const oldTree = await writeTree(ctx, [
          { name: 'old.txt', mode: FILE_MODE.REGULAR as FileMode, id: oldBlob },
        ]);
        const newTree = await writeTree(ctx, [
          { name: 'new.txt', mode: FILE_MODE.REGULAR as FileMode, id: newBlob },
        ]);
        const b = await writeCommitWithParents(ctx, baseTree, []);
        const olderW = await writeCommitWithParents(ctx, oldTree, [b, b]);
        const newerW = await writeCommitWithParents(ctx, newTree, [b, b]);
        await pushStashRef(ctx, olderW, 'WIP on main: 000 older');
        await pushStashRef(ctx, newerW, 'WIP on main: 111 newer');
        const sut = factoryFor(ctx);

        // Act
        const entry = await sut.stashEntry(1);

        // Assert — index 1 is the older push (old.txt), not the newest (new.txt).
        expect(entry).not.toBeNull();
        if (entry === null) return;
        expect((await collect(entry.workdir.entries())).map((r) => r.path)).toEqual(['old.txt']);
      });
    });
  });

  describe('Given a populated index', () => {
    describe('When sut.index() is iterated', () => {
      it('Then it yields the index rows', async () => {
        // Arrange — empty index suffices to assert the factory wires the resolver.
        const ctx = await buildSeededContext();
        const sut = factoryFor(ctx);

        // Act
        const rows = await collect(sut.index().entries());

        // Assert
        expect(rows).toEqual([]);
      });
    });
  });

  describe('Given an empty workdir', () => {
    describe('When sut.workdir() is iterated', () => {
      it('Then it yields no rows', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = factoryFor(ctx);

        // Act
        const rows = await collect(sut.workdir().entries());

        // Assert
        expect(rows).toEqual([]);
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { diffTrees } from '../../../../src/application/primitives/diff-trees.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { Blob, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

const blob = (ctx: Ctx, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const subTree = (ctx: Ctx, name: string, id: ObjectId, mode: FileMode): Promise<ObjectId> =>
  writeTree(ctx, [{ name, mode, id }]);

describe('diffTrees', () => {
  describe('Given undefined vs undefined', () => {
    describe('When diffTrees is called', () => {
      it('Then returns an empty TreeDiff', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = await diffTrees(ctx, undefined, undefined);
        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given a single blob added between two trees', () => {
    describe('When diffTrees is called', () => {
      it('Then yields one AddChange', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);
        const emptyId = await writeTree(ctx, []);
        const withEntryId = await writeTree(ctx, [
          { name: 'a.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const sut = await diffTrees(ctx, emptyId, withEntryId);
        // Assert
        expect(sut.changes.length).toBe(1);
        expect(sut.changes[0]?.type).toBe('add');
      });
    });
  });

  describe('Given two identical trees', () => {
    describe('When diffTrees is called', () => {
      it('Then returns empty diff', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const emptyId = await writeTree(ctx, []);
        const sut = await diffTrees(ctx, emptyId, emptyId);
        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given detectRenames=true and a rename candidate pair', () => {
    describe('When diffTrees is called', () => {
      it('Then invokes rename detection (distinguishable from default)', async () => {
        // Arrange — a delete + add pair on a unique-content blob that the rename
        // detector will collapse into a single 'rename' change.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('unique content for rename detection test');
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content,
          id: '' as ObjectId,
        });
        const before = await writeTree(ctx, [
          { name: 'src.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'dst.txt', mode: '100644' as FileMode, id: blobId },
        ]);

        const withDetect = await diffTrees(ctx, before, after, { detectRenames: true });
        const withoutDetect = await diffTrees(ctx, before, after);

        // Assert — the two results must differ: detectRenames emits a rename,
        // default emits separate delete+add. Kills the BooleanLiteral mutant on
        // `options?.detectRenames === true`.
        expect(withDetect).not.toEqual(withoutDetect);
        expect(withDetect.changes.some((c) => c.type === 'rename')).toBe(true);
      });
    });
  });

  describe('Given recursive=true and a sub-directory added between two trees', () => {
    describe('When diffTrees is called', () => {
      it('Then the nested blob surfaces as a full-path AddChange', async () => {
        // Arrange — empty root vs root carrying `sub/inner.txt`.
        const ctx = await buildSeededContext();
        const innerId = await blob(ctx, 'inner');
        const subId = await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR);
        const empty = await writeTree(ctx, []);
        const withSub = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subId },
        ]);

        // Act
        const sut = await diffTrees(ctx, empty, withSub, { recursive: true });

        // Assert — one per-file add, keyed by the full slash path (not `sub`).
        expect(sut.changes.length).toBe(1);
        const change = sut.changes[0];
        expect(change).toEqual({
          type: 'add',
          newPath: 'sub/inner.txt',
          newId: innerId,
          newMode: FILE_MODE.REGULAR,
        });
      });
    });
  });

  describe('Given recursive=true and an undefined old side (root-vs-empty)', () => {
    describe('When diffTrees is called', () => {
      it('Then every nested blob surfaces as a full-path AddChange', async () => {
        // Arrange — the root-commit case: no parent tree, so the old side is
        // undefined. Exercises the undefined-projection branch.
        const ctx = await buildSeededContext();
        const innerId = await blob(ctx, 'inner');
        const withSub = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR),
          },
        ]);

        // Act
        const sut = await diffTrees(ctx, undefined, withSub, { recursive: true });

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'add',
            newPath: 'sub/inner.txt',
            newId: innerId,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given recursive=true and a blob modified inside a sub-directory', () => {
    describe('When diffTrees is called', () => {
      it('Then the change is a full-path ModifyChange (not a tree-oid modify)', async () => {
        // Arrange — `sub/inner.txt` changes content; the parent `sub` tree-oid
        // also changes, which the non-recursive path would surface instead.
        const ctx = await buildSeededContext();
        const oldBlob = await blob(ctx, 'old');
        const newBlob = await blob(ctx, 'new');
        const before = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'inner.txt', oldBlob, FILE_MODE.REGULAR),
          },
        ]);
        const after = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'inner.txt', newBlob, FILE_MODE.REGULAR),
          },
        ]);

        // Act
        const sut = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'sub/inner.txt',
            oldId: oldBlob,
            newId: newBlob,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given recursive=true and a sub-directory deleted between two trees', () => {
    describe('When diffTrees is called', () => {
      it('Then the nested blob surfaces as a full-path DeleteChange', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const innerId = await blob(ctx, 'inner');
        const withSub = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR),
          },
        ]);
        const empty = await writeTree(ctx, []);

        // Act
        const sut = await diffTrees(ctx, withSub, empty, { recursive: true });

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'delete',
            oldPath: 'sub/inner.txt',
            oldId: innerId,
            oldMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given recursive=true and a nested path whose kind changes', () => {
    describe('When diffTrees is called', () => {
      it('Then the change is a full-path TypeChangeChange', async () => {
        // Arrange — `sub/x` is a regular file before and a symlink after.
        const ctx = await buildSeededContext();
        const fileId = await blob(ctx, 'contents');
        const linkId = await blob(ctx, 'target/path');
        const before = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'x', fileId, FILE_MODE.REGULAR),
          },
        ]);
        const after = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'x', linkId, FILE_MODE.SYMLINK),
          },
        ]);

        // Act
        const sut = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'type-change',
            path: 'sub/x',
            oldId: fileId,
            newId: linkId,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        ]);
      });
    });
  });

  describe('Given recursive=true and detectRenames=true with a nested move', () => {
    describe('When diffTrees is called', () => {
      it('Then a cross-directory rename is detected on full paths', async () => {
        // Arrange — identical blob moves from `a/old.txt` to `b/new.txt`.
        const ctx = await buildSeededContext();
        const content = 'unique content that the rename detector will match exactly\n'.repeat(4);
        const blobId = await blob(ctx, content);
        const before = await writeTree(ctx, [
          {
            name: 'a',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'old.txt', blobId, FILE_MODE.REGULAR),
          },
        ]);
        const after = await writeTree(ctx, [
          {
            name: 'b',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'new.txt', blobId, FILE_MODE.REGULAR),
          },
        ]);

        // Act
        const sut = await diffTrees(ctx, before, after, { recursive: true, detectRenames: true });

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'rename',
            oldPath: 'a/old.txt',
            newPath: 'b/new.txt',
            oldId: blobId,
            newId: blobId,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ]);
      });
    });
  });

  describe('Given detectRenames=true and an edited-then-moved file (inexact rename)', () => {
    describe('When diffTrees is called with a threshold', () => {
      it('Then the add/delete pair surfaces as a sub-100% rename (not separate A/D)', async () => {
        // Arrange — same blob with one line changed → moves to a new path.
        // Before slice 3 this emits a separate delete+add; after the slice it emits a rename.
        const ctx = await buildSeededContext();
        const srcContent = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join('');
        const dstContent = srcContent.replace('line 0\n', 'changed line 0\n');
        const srcId = await blob(ctx, srcContent);
        const dstId = await blob(ctx, dstContent);
        const before = await writeTree(ctx, [
          { name: 'original.txt', mode: FILE_MODE.REGULAR, id: srcId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'moved.txt', mode: FILE_MODE.REGULAR, id: dstId },
        ]);

        // Act — with detectRenames and a low threshold
        const sut = await diffTrees(ctx, before, after, {
          detectRenames: true,
          renameOptions: { threshold: 1 },
        });

        // Assert — one rename, not separate A + D
        expect(sut.changes).toHaveLength(1);
        const change = sut.changes[0];
        expect(change?.type).toBe('rename');
        if (change?.type === 'rename') {
          expect(change.oldPath).toBe('original.txt');
          expect(change.newPath).toBe('moved.txt');
          expect(change.oldId).toBe(srcId);
          expect(change.newId).toBe(dstId);
          expect(change.similarity.score).toBeGreaterThan(0);
          expect(change.similarity.score).toBeLessThan(MAX_SCORE);
        }
      });
    });
  });

  describe('Given recursive is absent (default) and a sub-directory changes', () => {
    describe('When diffTrees is called', () => {
      it('Then the sub-directory surfaces as a single tree-entry change (non-recursive)', async () => {
        // Arrange — same trees as the recursive-modify case; the default path
        // must report one `modify` on `sub` carrying tree oids, not per-file.
        const ctx = await buildSeededContext();
        const subBefore = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'old'),
          FILE_MODE.REGULAR,
        );
        const subAfter = await subTree(ctx, 'inner.txt', await blob(ctx, 'new'), FILE_MODE.REGULAR);
        const before = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
        ]);

        // Act
        const sut = await diffTrees(ctx, before, after);

        // Assert — one change, on `sub`, carrying the two *tree* oids.
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'sub',
            oldId: subBefore,
            newId: subAfter,
            oldMode: FILE_MODE.DIRECTORY,
            newMode: FILE_MODE.DIRECTORY,
          },
        ]);
      });
    });
  });

  describe('Given an already-resolved Tree object passed directly', () => {
    describe('When diffTrees is called', () => {
      it('Then returns the correct diff without invoking readTree', async () => {
        // Arrange — kills the ConditionalExpression mutant at resolveInput's
        // undefined guard.
        const ctx = await buildSeededContext();
        const emptyId = await writeTree(ctx, []);
        const blob: Blob = {
          type: 'blob',
          content: new Uint8Array([1, 2, 3]),
          id: '' as ObjectId,
        };
        const blobId = await writeObject(ctx, blob);
        const treeA = { type: 'tree' as const, id: emptyId, entries: [] };
        const treeB = {
          type: 'tree' as const,
          id: '' as ObjectId,
          entries: [{ name: 'f.txt', mode: '100644' as FileMode, id: blobId }],
        };
        const sut = await diffTrees(ctx, treeA, treeB);

        // Assert
        expect(sut.changes.length).toBe(1);
        expect(sut.changes[0]?.type).toBe('add');
      });
    });
  });

  describe('Given withStat=true and a one-line blob added', () => {
    describe('When diffTrees is called', () => {
      it('Then the change carries its line counts', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'only line\n');
        const empty = await writeTree(ctx, []);
        const withEntry = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);

        // Act
        const sut = await diffTrees(ctx, empty, withEntry, { withStat: true });

        // Assert
        expect(sut.changes[0]).toMatchObject({ type: 'add', added: 1, deleted: 0, binary: false });
      });
    });
  });

  describe('Given withStat=true and a one-line blob modified', () => {
    describe('When diffTrees is called', () => {
      it('Then the change carries one added and one deleted line', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const before = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: await blob(ctx, 'a\n') },
        ]);
        const after = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: await blob(ctx, 'b\n') },
        ]);

        // Act
        const sut = await diffTrees(ctx, before, after, { withStat: true });

        // Assert
        expect(sut.changes[0]).toMatchObject({
          type: 'modify',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given withStat=true and a one-line blob deleted', () => {
    describe('When diffTrees is called', () => {
      it('Then the change carries one deleted line', async () => {
        // Arrange — exercises the new-content-absent branch of stat hydration.
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'gone\n');
        const withEntry = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const empty = await writeTree(ctx, []);

        // Act
        const sut = await diffTrees(ctx, withEntry, empty, { withStat: true });

        // Assert
        expect(sut.changes[0]).toMatchObject({
          type: 'delete',
          added: 0,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given withStat is omitted and a one-line blob added', () => {
    describe('When diffTrees is called', () => {
      it('Then the change carries no count fields (tree-level only)', async () => {
        // Arrange — kills the BooleanLiteral mutant on the withStat guard: the
        // default path must NOT compute counts.
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'only line\n');
        const empty = await writeTree(ctx, []);
        const withEntry = await writeTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);

        // Act
        const sut = await diffTrees(ctx, empty, withEntry);

        // Assert
        expect(sut.changes[0]).not.toHaveProperty('added');
        expect(sut.changes[0]).not.toHaveProperty('binary');
      });
    });
  });
});

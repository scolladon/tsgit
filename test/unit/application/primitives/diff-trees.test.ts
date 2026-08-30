import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { diffRecursive, diffTrees } from '../../../../src/application/primitives/diff-trees.js';
import * as flattenRawMod from '../../../../src/application/primitives/internal/flatten-raw.js';
import * as walkRawSubtreeMod from '../../../../src/application/primitives/internal/walk-raw-subtree.js';
import * as materialisePatchFilesMod from '../../../../src/application/primitives/materialise-patch-files.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { MAX_PEEL_DEPTH } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import {
  type LineKey,
  MAX_DIFF_LINES,
  type WhitespaceMode,
} from '../../../../src/domain/diff/index.js';
import * as rawTreeDiffMod from '../../../../src/domain/diff/raw-tree-diff.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import * as statFieldsMod from '../../../../src/domain/diff/stat-fields.js';
import * as encodingMod from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import { SHA1_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type {
  Blob,
  FileMode,
  FilePath,
  ObjectId,
  Tree,
} from '../../../../src/domain/objects/index.js';
import {
  serializeTreeContent,
  type TreeEntry,
  treeEntry,
} from '../../../../src/domain/objects/tree.js';
import type { CommandRunner } from '../../../../src/ports/command-runner.js';
import { buildSeededContext, instrumentedContext, seedMaxTreeDepth } from './fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

const IDENTITY = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const blob = (ctx: Ctx, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const subTree = (ctx: Ctx, name: string, id: ObjectId, mode: FileMode): Promise<ObjectId> =>
  writeTree(ctx, [treeEntry(mode, name, id)]);

/** Build a chain of `hops` real nested directory-modify levels whose
 *  innermost entry points to a phantom (never-written) id on each side — a
 *  depth guard that failed to trip surfaces as OBJECT_NOT_FOUND, not a
 *  silent pass, so this shape is reserved for tests asserting the throw. */
const buildPhantomModifyChain = async (
  ctx: Ctx,
  hops: number,
): Promise<{ oldId: ObjectId; newId: ObjectId }> => {
  const PHANTOM_OLD = 'b'.repeat(40) as ObjectId;
  const PHANTOM_NEW = 'c'.repeat(40) as ObjectId;
  let oldId: ObjectId = await subTree(ctx, 'sub', PHANTOM_OLD, FILE_MODE.DIRECTORY);
  let newId: ObjectId = await subTree(ctx, 'sub', PHANTOM_NEW, FILE_MODE.DIRECTORY);
  for (let i = 0; i < hops; i++) {
    oldId = await subTree(ctx, 'sub', oldId, FILE_MODE.DIRECTORY);
    newId = await subTree(ctx, 'sub', newId, FILE_MODE.DIRECTORY);
  }
  return { oldId, newId };
};

/** Build a chain of `hops` real nested directory-modify levels whose
 *  innermost entry is a real, differing leaf blob — never touches a phantom
 *  id, so it can only ever complete or throw TREE_DEPTH_EXCEEDED, never
 *  OBJECT_NOT_FOUND. */
const buildRealModifyChain = async (
  ctx: Ctx,
  hops: number,
): Promise<{ oldId: ObjectId; newId: ObjectId }> => {
  const oldLeaf = await blob(ctx, 'old-leaf');
  const newLeaf = await blob(ctx, 'new-leaf');
  let oldId = await subTree(ctx, 'sub', oldLeaf, FILE_MODE.REGULAR);
  let newId = await subTree(ctx, 'sub', newLeaf, FILE_MODE.REGULAR);
  for (let i = 0; i < hops; i++) {
    oldId = await subTree(ctx, 'sub', oldId, FILE_MODE.DIRECTORY);
    newId = await subTree(ctx, 'sub', newId, FILE_MODE.DIRECTORY);
  }
  return { oldId, newId };
};

/** Build a chain of `levels` nested DIRECTORY wrappers around a real leaf
 *  tree — used as a whole-directory ADD (or, read backwards, DELETE) so the
 *  recursive diff expands it via `walkRawSubtree`. */
const buildDirectoryChain = async (ctx: Ctx, levels: number): Promise<ObjectId> => {
  const leaf = await blob(ctx, 'added-leaf');
  let current = await subTree(ctx, 'leaf', leaf, FILE_MODE.REGULAR);
  for (let i = 0; i < levels; i++) {
    current = await subTree(ctx, 'sub', current, FILE_MODE.DIRECTORY);
  }
  return current;
};

/** Build a `readRawObject`-shaped stub for a hand-forged self-referential
 *  tree — `bytes` mirrors `content` since these cycle-detection tests only
 *  ever inspect `.type`/`.content`, never the raw header+content encoding. */
const rawTreeStub = (tree: Tree): { type: 'tree'; content: Uint8Array; bytes: Uint8Array } => {
  const content = serializeTreeContent(tree, SHA1_CONFIG);
  return { type: 'tree', content, bytes: content };
};

describe('diffTrees', () => {
  describe('Given undefined vs undefined', () => {
    describe('When diffTrees is called', () => {
      it('Then returns an empty TreeDiff', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await diffTrees(ctx, undefined, undefined);

        // Assert
        expect(result.changes).toEqual([]);
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
          treeEntry('100644' as FileMode, 'a.txt', blobId),
        ]);

        // Act
        const result = await diffTrees(ctx, emptyId, withEntryId);

        // Assert
        expect(result.changes.length).toBe(1);
        expect(result.changes[0]?.type).toBe('add');
      });
    });
  });

  describe('Given two identical trees', () => {
    describe('When diffTrees is called', () => {
      it('Then returns empty diff', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const emptyId = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, emptyId, emptyId);

        // Assert
        expect(result.changes).toEqual([]);
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
        const before = await writeTree(ctx, [treeEntry('100644' as FileMode, 'src.txt', blobId)]);
        const after = await writeTree(ctx, [treeEntry('100644' as FileMode, 'dst.txt', blobId)]);

        // Act
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

  describe('Given recursive=true and two sibling directories sharing one changed subtree oid', () => {
    describe('When diffTrees is called', () => {
      it('Then both branches diff, with no false TREE_CYCLE_DETECTED', async () => {
        // Arrange — x/ and y/ hold the SAME subtree oid on each side, and both
        // change. The two descents run concurrently and share one cursor, so
        // each must see only its own root-to-current path: an ancestry shared
        // mutably between siblings would read the second as a repeat visit.
        const ctx = await buildSeededContext();
        const oldInner = await blob(ctx, 'before');
        const newInner = await blob(ctx, 'after');
        const oldSub = await subTree(ctx, 'f.txt', oldInner, FILE_MODE.REGULAR);
        const newSub = await subTree(ctx, 'f.txt', newInner, FILE_MODE.REGULAR);
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'x', oldSub),
          treeEntry(FILE_MODE.DIRECTORY, 'y', oldSub),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'x', newSub),
          treeEntry(FILE_MODE.DIRECTORY, 'y', newSub),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert — both branches surface, keyed by their own full path.
        const paths = result.changes
          .flatMap((change) => ('path' in change ? [change.path] : []))
          .sort();
        expect(paths).toEqual(['x/f.txt', 'y/f.txt']);
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
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);

        // Act
        const result = await diffTrees(ctx, empty, withSub, { recursive: true });

        // Assert — one per-file add, keyed by the full slash path (not `sub`).
        expect(result.changes.length).toBe(1);
        const change = result.changes[0];
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
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR),
          ),
        ]);

        // Act
        const result = await diffTrees(ctx, undefined, withSub, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
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
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', oldBlob, FILE_MODE.REGULAR),
          ),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', newBlob, FILE_MODE.REGULAR),
          ),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
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
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR),
          ),
        ]);
        const empty = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, withSub, empty, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
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
          treeEntry(FILE_MODE.DIRECTORY, 'sub', await subTree(ctx, 'x', fileId, FILE_MODE.REGULAR)),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'sub', await subTree(ctx, 'x', linkId, FILE_MODE.SYMLINK)),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
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

  describe('Given recursive=true and multiple files added inside a nested sub-directory', () => {
    describe('When diffTrees is called', () => {
      it('Then every nested file surfaces as its own full-path AddChange, in tree order', async () => {
        // Arrange — empty root vs root carrying `sub/a.txt` and `sub/b.txt`.
        const ctx = await buildSeededContext();
        const aId = await blob(ctx, 'a');
        const bId = await blob(ctx, 'b');
        const subId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt', aId),
          treeEntry(FILE_MODE.REGULAR, 'b.txt', bId),
        ]);
        const empty = await writeTree(ctx, []);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);

        // Act
        const result = await diffTrees(ctx, empty, withSub, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'sub/a.txt', newId: aId, newMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'sub/b.txt', newId: bId, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given recursive=true and multiple files deleted inside a nested sub-directory', () => {
    describe('When diffTrees is called', () => {
      it('Then every nested file surfaces as its own full-path DeleteChange, in tree order', async () => {
        // Arrange — root carrying `sub/a.txt` and `sub/b.txt` vs empty root.
        const ctx = await buildSeededContext();
        const aId = await blob(ctx, 'a');
        const bId = await blob(ctx, 'b');
        const subId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt', aId),
          treeEntry(FILE_MODE.REGULAR, 'b.txt', bId),
        ]);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);
        const empty = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, withSub, empty, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'sub/a.txt', oldId: aId, oldMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'sub/b.txt', oldId: bId, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given recursive=true and a duplicate-name tree added as a whole sub-directory', () => {
    describe('When diffTrees is called', () => {
      it('Then every duplicate entry surfaces as its own AddChange (per-entry, not de-duplicated)', async () => {
        // Arrange — `sub/dup.txt` appears twice inside the added subtree; git's
        // `diff-tree -r` emits one add per entry, so the expansion must not
        // collapse the two into a single last-wins entry the way a Map would.
        const ctx = await buildSeededContext();
        const dupAId = await blob(ctx, 'a');
        const dupBId = await blob(ctx, 'b');
        const subId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'dup.txt', dupAId),
          treeEntry(FILE_MODE.REGULAR, 'dup.txt', dupBId),
        ]);
        const empty = await writeTree(ctx, []);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);

        // Act
        const result = await diffTrees(ctx, empty, withSub, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          { type: 'add', newPath: 'sub/dup.txt', newId: dupAId, newMode: FILE_MODE.REGULAR },
          { type: 'add', newPath: 'sub/dup.txt', newId: dupBId, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given recursive=true and a duplicate-name tree deleted as a whole sub-directory', () => {
    describe('When diffTrees is called', () => {
      it('Then every duplicate entry surfaces as its own DeleteChange (per-entry, not de-duplicated)', async () => {
        // Arrange — symmetric to the added-subtree case above.
        const ctx = await buildSeededContext();
        const dupAId = await blob(ctx, 'a');
        const dupBId = await blob(ctx, 'b');
        const subId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'dup.txt', dupAId),
          treeEntry(FILE_MODE.REGULAR, 'dup.txt', dupBId),
        ]);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);
        const empty = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, withSub, empty, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          { type: 'delete', oldPath: 'sub/dup.txt', oldId: dupAId, oldMode: FILE_MODE.REGULAR },
          { type: 'delete', oldPath: 'sub/dup.txt', oldId: dupBId, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given recursive=true and a change three directory levels deep (a/b/c)', () => {
    describe('When diffTrees is called', () => {
      it('Then the change is a full-path ModifyChange threaded through every level', async () => {
        // Arrange — `a/b/c/leaf.txt` changes content; every ancestor tree-oid
        // (c, b, a) also changes, exercising diffChangedSubtree recursion
        // through three real levels.
        const ctx = await buildSeededContext();
        const oldLeaf = await blob(ctx, 'old');
        const newLeaf = await blob(ctx, 'new');
        const oldC = await subTree(ctx, 'leaf.txt', oldLeaf, FILE_MODE.REGULAR);
        const newC = await subTree(ctx, 'leaf.txt', newLeaf, FILE_MODE.REGULAR);
        const oldB = await subTree(ctx, 'c', oldC, FILE_MODE.DIRECTORY);
        const newB = await subTree(ctx, 'c', newC, FILE_MODE.DIRECTORY);
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'a', await subTree(ctx, 'b', oldB, FILE_MODE.DIRECTORY)),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'a', await subTree(ctx, 'b', newB, FILE_MODE.DIRECTORY)),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'a/b/c/leaf.txt',
            oldId: oldLeaf,
            newId: newLeaf,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given recursive=true and both inputs are commit oids (peel to their trees)', () => {
    describe('When diffTrees is called', () => {
      it('Then diffs the peeled trees, not the commits themselves', async () => {
        // Arrange — resolveRawInput must peel commit -> tree exactly like
        // readTree, so a commit oid keeps working through the raw path.
        const ctx = await buildSeededContext();
        const oldFileId = await blob(ctx, 'old');
        const newFileId = await blob(ctx, 'new');
        const oldTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'root.txt', oldFileId),
        ]);
        const newTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'root.txt', newFileId),
        ]);
        const oldCommitId = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: oldTreeId,
            parents: [],
            author: IDENTITY,
            committer: IDENTITY,
            message: 'old',
            extraHeaders: [],
          },
        });
        const newCommitId = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: newTreeId,
            parents: [],
            author: IDENTITY,
            committer: IDENTITY,
            message: 'new',
            extraHeaders: [],
          },
        });

        // Act
        const result = await diffTrees(ctx, oldCommitId, newCommitId, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'root.txt',
            oldId: oldFileId,
            newId: newFileId,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given recursive=true and an unchanged (TREESAME) sub-directory alongside a changed file', () => {
    describe('When diffTrees is called', () => {
      it('Then walkRawSubtree is never invoked (the TREESAME subtree is pruned before any read)', async () => {
        // Arrange — `big/` is byte-identical (same tree oid) on both sides;
        // only the root-level file differs.
        const ctx = await buildSeededContext();
        const unchangedSubId = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'inner'),
          FILE_MODE.REGULAR,
        );
        const oldFileId = await blob(ctx, 'old');
        const newFileId = await blob(ctx, 'new');
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'big', unchangedSubId),
          treeEntry(FILE_MODE.REGULAR, 'root.txt', oldFileId),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'big', unchangedSubId),
          treeEntry(FILE_MODE.REGULAR, 'root.txt', newFileId),
        ]);
        const walkSpy = vi.spyOn(walkRawSubtreeMod, 'walkRawSubtree');
        const readRawObjectSpy = vi.spyOn(readObjectMod, 'readRawObject');

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert — no subtree was ever expanded; only the differing file changed.
        expect(walkSpy).not.toHaveBeenCalled();
        // Assert — the unchanged subtree's own bytes are never read either (not
        // just never walked): TREESAME is pruned before any object read for it.
        expect(readRawObjectSpy.mock.calls.some(([, id]) => id === unchangedSubId)).toBe(false);
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'root.txt',
            oldId: oldFileId,
            newId: newFileId,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
        walkSpy.mockRestore();
        readRawObjectSpy.mockRestore();
      });
    });
  });

  describe('Given recursive=true and a large unchanged sub-directory alongside a small change', () => {
    describe('When diffTrees is called', () => {
      it('Then bytesToHex/decode calls scale with entries actually read, not the unchanged subtree size', async () => {
        // Arrange — `big/` carries 20 unread entries; only `root.txt` differs.
        const ctx = await buildSeededContext();
        const manyEntries = [];
        for (let i = 0; i < 20; i++) {
          manyEntries.push(
            treeEntry(FILE_MODE.REGULAR, `f${i}.txt`, await blob(ctx, `content-${i}`)),
          );
        }
        const unchangedSubId = await writeTree(ctx, manyEntries);
        const oldFileId = await blob(ctx, 'old');
        const newFileId = await blob(ctx, 'new');
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'big', unchangedSubId),
          treeEntry(FILE_MODE.REGULAR, 'root.txt', oldFileId),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'big', unchangedSubId),
          treeEntry(FILE_MODE.REGULAR, 'root.txt', newFileId),
        ]);
        const bytesToHexSpy = vi.spyOn(encodingMod, 'bytesToHex');
        const decodeSpy = vi.spyOn(encodingMod, 'decode');
        const decodePreservingBomSpy = vi.spyOn(encodingMod, 'decodePreservingBom');

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert — well under the 20-entry unchanged subtree: only the emitted
        // `root.txt` entry's two oids are ever hex-converted (the unchanged
        // `big/` comparison is byte-level, no conversion at all) — one call for
        // oldId, one for newId (cursorOid on each side of `root.txt`); `decode`
        // runs exactly 2 times — one per raw object header read at the root
        // level (old side + new side, via peelToTree/splitObject); building the
        // emitted `root.txt` entry's name now goes through the BOM-preserving
        // decoder (cursorName), one call.
        expect(result.changes).toHaveLength(1);
        expect(bytesToHexSpy.mock.calls.length).toBe(2);
        expect(decodeSpy.mock.calls.length).toBe(2);
        expect(decodePreservingBomSpy.mock.calls.length).toBe(1);
        bytesToHexSpy.mockRestore();
        decodeSpy.mockRestore();
        decodePreservingBomSpy.mockRestore();
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
          treeEntry(
            FILE_MODE.DIRECTORY,
            'a',
            await subTree(ctx, 'old.txt', blobId, FILE_MODE.REGULAR),
          ),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'b',
            await subTree(ctx, 'new.txt', blobId, FILE_MODE.REGULAR),
          ),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          recursive: true,
          detectRenames: true,
        });

        // Assert
        expect(result.changes).toEqual([
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
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'original.txt', srcId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'moved.txt', dstId)]);

        // Act — with detectRenames and a low threshold
        const result = await diffTrees(ctx, before, after, {
          detectRenames: true,
          renameOptions: { threshold: 1 },
        });

        // Assert — one rename, not separate A + D
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
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
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subBefore)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subAfter)]);

        // Act
        const result = await diffTrees(ctx, before, after);

        // Assert — one change, on `sub`, carrying the two *tree* oids.
        expect(result.changes).toEqual([
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
          entries: [treeEntry('100644' as FileMode, 'f.txt', blobId)],
        };

        // Act
        const result = await diffTrees(ctx, treeA, treeB);

        // Assert
        expect(result.changes.length).toBe(1);
        expect(result.changes[0]?.type).toBe('add');
      });
    });
  });

  describe('Given caller-supplied Tree objects (not oids) with recursive:true', () => {
    describe('When diffTrees is called with the Tree objects vs with their oids', () => {
      it('Then both forms produce the identical DiffChange[]', async () => {
        // Arrange — a nested change, resolved to Tree objects (rather than oid strings).
        const ctx = await buildSeededContext();
        const oldLeaf = await blob(ctx, 'old');
        const newLeaf = await blob(ctx, 'new');
        const beforeId = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', oldLeaf, FILE_MODE.REGULAR),
          ),
        ]);
        const afterId = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', newLeaf, FILE_MODE.REGULAR),
          ),
        ]);
        const beforeObject = (await readObject(ctx, beforeId)) as Tree;
        const afterObject = (await readObject(ctx, afterId)) as Tree;

        // Act
        const fromObjects = await diffTrees(ctx, beforeObject, afterObject, { recursive: true });
        const fromOids = await diffTrees(ctx, beforeId, afterId, { recursive: true });

        // Assert — resolveRawInput re-reads a Tree object by its `id`, so both
        // forms must agree exactly.
        expect(fromObjects.changes).toEqual(fromOids.changes);
        expect(fromObjects.changes).toEqual([
          {
            type: 'modify',
            path: 'sub/inner.txt',
            oldId: oldLeaf,
            newId: newLeaf,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given a hand-forged Tree object whose id is not present in the store', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws OBJECT_NOT_FOUND (the Tree is re-read by its id, not walked directly)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const emptyId = await writeTree(ctx, []);
        const unknownId = 'f'.repeat(40) as ObjectId;
        const forgedTree: Tree = { type: 'tree', id: unknownId, entries: [] };

        // Act + Assert
        try {
          await diffTrees(ctx, emptyId, forgedTree, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; id: string } };
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          expect(data.id).toBe(unknownId);
        }
      });
    });
  });

  describe('Given withStat=true and a one-line blob added, modified, or deleted', () => {
    describe('When diffTrees is called', () => {
      it.each([
        {
          label: 'added',
          build: async (ctx: Ctx): Promise<{ before: ObjectId; after: ObjectId }> => {
            const blobId = await blob(ctx, 'only line\n');
            const empty = await writeTree(ctx, []);
            const withEntry = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a.txt', blobId)]);
            return { before: empty, after: withEntry };
          },
          expected: { type: 'add', added: 1, deleted: 0, binary: false },
        },
        {
          label: 'modified',
          build: async (ctx: Ctx): Promise<{ before: ObjectId; after: ObjectId }> => {
            const before = await writeTree(ctx, [
              treeEntry(FILE_MODE.REGULAR, 'a.txt', await blob(ctx, 'a\n')),
            ]);
            const after = await writeTree(ctx, [
              treeEntry(FILE_MODE.REGULAR, 'a.txt', await blob(ctx, 'b\n')),
            ]);
            return { before, after };
          },
          expected: { type: 'modify', added: 1, deleted: 1, binary: false },
        },
        {
          // exercises the new-content-absent branch of stat hydration.
          label: 'deleted',
          build: async (ctx: Ctx): Promise<{ before: ObjectId; after: ObjectId }> => {
            const blobId = await blob(ctx, 'gone\n');
            const withEntry = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a.txt', blobId)]);
            const empty = await writeTree(ctx, []);
            return { before: withEntry, after: empty };
          },
          expected: { type: 'delete', added: 0, deleted: 1, binary: false },
        },
      ])('Then the change carries $label line counts', async ({ build, expected }) => {
        // Arrange
        const ctx = await buildSeededContext();
        const { before, after } = await build(ctx);

        // Act
        const result = await diffTrees(ctx, before, after, { withStat: true });

        // Assert
        expect(result.changes[0]).toMatchObject(expected);
      });
    });
  });

  describe('Given copies:"harder" and a file unchanged in treeA whose preimage is similar to an added file in treeB', () => {
    describe('When diffTrees is called with detectRenames:true and renameOptions:{copies:"harder"}', () => {
      it('Then the add folds into a copy from the unchanged source (preimage threading works end-to-end)', async () => {
        // Arrange — treeA has one file (unchanged, not appearing in diff changes).
        // treeB adds a new file similar to treeA's file.
        // Under copies:'on': no copy (unchanged is not a modified-file source).
        // Under copies:'harder': copy IS detected (unchanged file enters the source set via preimage threading).
        const ctx = await buildSeededContext();
        // Build a 10-line blob
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i}: shared content\n`).join('');
        const unchangedId = await blob(ctx, lines);
        const dstLines = lines.replace(
          'line 0: shared content\n',
          'COPY DST line 0: shared content\n',
        );
        const dstId = await blob(ctx, dstLines);

        const treeA = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'orig.txt', unchangedId)]);
        const treeB = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'orig.txt', unchangedId), // unchanged
          treeEntry(FILE_MODE.REGULAR, 'copy.txt', dstId), // new, similar to orig
        ]);

        // Act — without copies:'harder': should not detect copy (unchanged excluded)
        const resultOn = await diffTrees(ctx, treeA, treeB, {
          detectRenames: true,
          renameOptions: { copies: 'on' },
        });
        // Act — with copies:'harder': should detect copy from unchanged source
        const resultHarder = await diffTrees(ctx, treeA, treeB, {
          detectRenames: true,
          renameOptions: { copies: 'harder' },
        });

        // Assert — copies:'on': no copy, add stays as A
        expect(resultOn.changes.filter((c) => c.type === 'copy')).toHaveLength(0);
        expect(resultOn.changes.filter((c) => c.type === 'add')).toHaveLength(1);

        // Assert — copies:'harder': copy detected from unchanged source
        const copies = resultHarder.changes.filter((c) => c.type === 'copy');
        expect(copies).toHaveLength(1);
        if (copies[0]?.type === 'copy') {
          expect(copies[0].oldPath).toBe('orig.txt');
          expect(copies[0].newPath).toBe('copy.txt');
        }
        // The orig.txt itself is NOT in the diff (unchanged)
        expect(resultHarder.changes.filter((c) => c.type === 'add')).toHaveLength(0);
      });
    });
  });

  describe('Given copies:"on" with treeA present (buildPreimage should return undefined)', () => {
    describe('When diffTrees is called with detectRenames:true and renameOptions:{copies:"on"}', () => {
      it('Then no preimage is built and unchanged files are NOT copy sources (L70 ConditionalExpression "false")', async () => {
        // Arrange — copies:'on' with treeA=undefined; the guard must short-circuit so
        // flattenTree is never called with undefined (which would crash)
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'file content\n');
        // treeB only; no treeA (undefined)
        const treeB = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.txt', blobId)]);

        // Act — copies:'on', treeA=undefined: buildPreimage must return undefined (guard fires)
        const result = await diffTrees(ctx, undefined, treeB, {
          detectRenames: true,
          renameOptions: { copies: 'on' },
        });

        // Assert — add detected, no crash
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('add');
      });
    });
  });

  describe('Given copies:"harder" but treeA is undefined (buildPreimage returns undefined)', () => {
    describe('When diffTrees is called', () => {
      it('Then buildPreimage returns undefined and no crash occurs (L70 treeA===undefined arm)', async () => {
        // Arrange — copies:'harder' but treeA=undefined; the treeA===undefined arm of the guard
        // must prevent flattenTree from being called with undefined (which would crash)
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'content for harder test\n');
        const treeB = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.txt', blobId)]);

        // Act — copies:'harder' but treeA=undefined → preimage=undefined → no crash
        const result = await diffTrees(ctx, undefined, treeB, {
          detectRenames: true,
          renameOptions: { copies: 'harder' },
        });

        // Assert — add detected without crash
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('add');
      });
    });
  });

  describe('Given copies:"on" (not "harder") with treeA defined', () => {
    describe('When diffTrees is called with detectRenames:true and renameOptions:{copies:"on"}', () => {
      it('Then buildPreimage never flattens treeA (the copies!=="harder" guard is checked, not just treeA===undefined)', async () => {
        // Arrange — treeA IS defined here (unlike the sibling "treeA undefined" tests
        // above), isolating the left operand of buildPreimage's guard: only the
        // copies-mode check can short-circuit flattenRawTree for this input.
        // Spies on `flattenRawTree` (the raw-cursor descent buildPreimage actually
        // calls) — not the legacy `flattenTree`, which this path stopped using.
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'file content\n');
        const treeA = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'orig.txt', blobId)]);
        const treeB = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'orig.txt', blobId),
          treeEntry(FILE_MODE.REGULAR, 'new.txt', await blob(ctx, 'new\n')),
        ]);
        const flattenSpy = vi.spyOn(flattenRawMod, 'flattenRawTree');

        // Act
        const result = await diffTrees(ctx, treeA, treeB, {
          detectRenames: true,
          renameOptions: { copies: 'on' },
        });

        // Assert — no preimage was built for a non-'harder' copies mode
        expect(flattenSpy).not.toHaveBeenCalled();
        expect(result.changes.filter((c) => c.type === 'add')).toHaveLength(1);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given copies:"harder" and treeA is wrapped in a commit oid (must peel before flattening)', () => {
    describe('When diffTrees is called with detectRenames:true and renameOptions:{copies:"harder"}', () => {
      it.each([
        { label: 'non-recursive', recursive: false },
        { label: 'recursive', recursive: true },
      ])(
        'Then the commit-oid form detects the same copy as the tree-oid form ($label)',
        async ({ recursive }) => {
          // Arrange — treeA has one unchanged file; treeB adds a file similar to it.
          // copies:'harder' must fold the add into a copy from the unchanged source
          // whether `a` is passed as the tree directly or as a commit wrapping it.
          const ctx = await buildSeededContext();
          const lines = Array.from({ length: 10 }, (_, i) => `line ${i}: shared content\n`).join(
            '',
          );
          const unchangedId = await blob(ctx, lines);
          const dstLines = lines.replace(
            'line 0: shared content\n',
            'COPY DST line 0: shared content\n',
          );
          const dstId = await blob(ctx, dstLines);
          const treeA = await writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'orig.txt', unchangedId),
          ]);
          const treeB = await writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'orig.txt', unchangedId),
            treeEntry(FILE_MODE.REGULAR, 'copy.txt', dstId),
          ]);
          const commitA = await writeObject(ctx, {
            type: 'commit',
            id: '' as ObjectId,
            data: {
              tree: treeA,
              parents: [],
              author: IDENTITY,
              committer: IDENTITY,
              message: 'wrap treeA',
              extraHeaders: [],
            },
          });

          // Act
          const fromCommit = await diffTrees(ctx, commitA, treeB, {
            detectRenames: true,
            renameOptions: { copies: 'harder' },
            recursive,
          });
          const fromTree = await diffTrees(ctx, treeA, treeB, {
            detectRenames: true,
            renameOptions: { copies: 'harder' },
            recursive,
          });

          // Assert
          expect(fromCommit).toEqual(fromTree);
          const copies = fromCommit.changes.filter((c) => c.type === 'copy');
          expect(copies).toHaveLength(1);
          if (copies[0]?.type === 'copy') {
            expect(copies[0].oldPath).toBe('orig.txt');
            expect(copies[0].newPath).toBe('copy.txt');
          }
        },
      );
    });
  });

  describe('Given copies:"harder" and treeA wrapped in a commit oid', () => {
    describe('When diffTrees builds the preimage', () => {
      it('Then the terminal tree is read raw exactly once (the peeled bytes feed the preimage flatten directly)', async () => {
        // Arrange — peelToTree already reads the terminal tree's raw bytes as
        // its last hop; flattenRawTree must reuse them rather than re-reading
        // the same tree object a second time.
        const ctx = await buildSeededContext();
        const unchangedId = await blob(ctx, 'shared content\n');
        const treeA = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'orig.txt', unchangedId)]);
        const treeB = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'orig.txt', unchangedId)]);
        const commitA = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeA,
            parents: [],
            author: IDENTITY,
            committer: IDENTITY,
            message: 'wrap treeA',
            extraHeaders: [],
          },
        });
        const readRawObjectSpy = vi.spyOn(readObjectMod, 'readRawObject');

        // Act
        await diffTrees(ctx, commitA, treeB, {
          detectRenames: true,
          renameOptions: { copies: 'harder' },
        });

        // Assert
        const treeAReads = readRawObjectSpy.mock.calls.filter(([, id]) => id === treeA).length;
        expect(treeAReads).toBe(1);
        readRawObjectSpy.mockRestore();
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
        const withEntry = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a.txt', blobId)]);

        // Act
        const result = await diffTrees(ctx, empty, withEntry);

        // Assert
        expect(result.changes[0]).not.toHaveProperty('added');
        expect(result.changes[0]).not.toHaveProperty('binary');
      });
    });
  });

  describe('Given a whitespace-only modify and ignoreWhitespace:all', () => {
    describe('When diffTrees is called', () => {
      it('Then the ws-only modify is dropped from changes (#D1)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a modify change that must survive the ignoreWhitespace drop pass', () => {
    describe('When diffTrees is called', () => {
      const enc = new TextEncoder();

      it.each([
        {
          // no drop without a mode
          label: 'no whitespace mode is set at all',
          oldBytes: enc.encode('hello world\n'),
          newBytes: enc.encode('hello  world\n'),
          options: {},
        },
        {
          // only added>0 → shouldDrop must be false
          label: 'only added>0 (pure insert) under ignoreWhitespace:all',
          oldBytes: enc.encode('a\n'),
          newBytes: enc.encode('a\nXYZ\n'),
          options: { ignoreWhitespace: 'all' as const },
        },
        {
          // only deleted>0 → shouldDrop must be false
          label: 'only deleted>0 (pure delete) under ignoreWhitespace:all',
          oldBytes: enc.encode('a\nXYZ\n'),
          newBytes: enc.encode('a\n'),
          options: { ignoreWhitespace: 'all' as const },
        },
        {
          // ignoreBlankLines alone must NOT trigger the drop pass (lineKeyActive is false)
          label: 'ignoreBlankLines alone with no line-key mode (#BL1)',
          oldBytes: enc.encode('line\n'),
          newBytes: enc.encode('line\n\n'),
          options: { ignoreBlankLines: true },
        },
        {
          // NUL byte triggers binary detection; a binary modify is never dropped
          label: 'a binary modify under ignoreWhitespace:all (isolated binary guard)',
          oldBytes: new Uint8Array([104, 101, 108, 108, 111, 0, 32, 119, 111, 114, 108, 100]),
          newBytes: new Uint8Array([104, 101, 108, 108, 111, 0, 32, 32, 119, 111, 114, 108, 100]),
          options: { ignoreWhitespace: 'all' as const },
        },
      ])('Then the modify is kept ($label)', async ({ oldBytes, newBytes, options }) => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeObject(ctx, {
          type: 'blob',
          content: oldBytes,
          id: '' as ObjectId,
        });
        const newId = await writeObject(ctx, {
          type: 'blob',
          content: newBytes,
          id: '' as ObjectId,
        });
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, options);

        // Assert
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('modify');
      });
    });
  });

  describe('Given a mixed two-file diff (ws-only f + real g) and ignoreWhitespace:all', () => {
    describe('When diffTrees is called', () => {
      it('Then only the ws-only file is dropped, real change is kept (#D1)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fOldId = await blob(ctx, 'spaces here\n');
        const fNewId = await blob(ctx, 'spaces  here\n');
        const gOldId = await blob(ctx, 'alpha\n');
        const gNewId = await blob(ctx, 'beta\n');
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt', fOldId),
          treeEntry(FILE_MODE.REGULAR, 'g.txt', gOldId),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt', fNewId),
          treeEntry(FILE_MODE.REGULAR, 'g.txt', gNewId),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — only g.txt remains
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('modify');
        if (change?.type === 'modify') {
          expect(change.path).toBe('g.txt');
        }
      });
    });
  });

  describe('Given a spaces-only insert with ignoreWhitespace:all and ignoreBlankLines:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the modify is dropped (#BL-combo — line-key makes it whitespace-only)', async () => {
        // Arrange — a line of spaces is "blank" under mode 'all' (all ws dropped)
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'content\n');
        const newId = await blob(ctx, 'content\n   \n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          ignoreBlankLines: true,
        });

        // Assert — dropped (#BL-combo)
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a type-change and ignoreWhitespace:all', () => {
    describe('When diffTrees is called', () => {
      it('Then the type-change is never dropped (isolated type-change guard)', async () => {
        // Arrange — same content, different mode (regular → symlink)
        const ctx = await buildSeededContext();
        const fileId = await blob(ctx, '   ');
        const linkId = await blob(ctx, '   ');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'x', fileId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.SYMLINK, 'x', linkId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — type-change is never dropped
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('type-change');
      });
    });
  });

  describe('Given a whitespace-only rename and ignoreWhitespace:all with detectRenames:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the rename still pairs and is not dropped (drop targets modify only)', async () => {
        // Arrange — exact same content moved to a new path (MAX_SCORE similarity
        // guarantees rename detection regardless of threshold)
        const ctx = await buildSeededContext();
        const content = Array.from({ length: 10 }, (_, i) => `line ${i} content\n`).join('');
        const srcId = await blob(ctx, content);
        const dstId = srcId; // identical blob → rename with score MAX_SCORE
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'src.txt', srcId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'dst.txt', dstId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          detectRenames: true,
        });

        // Assert — rename present (similarity detection is whitespace-agnostic),
        // NOT dropped (drop only targets modify changes)
        expect(result.changes.some((c) => c.type === 'rename')).toBe(true);
        expect(result.changes).toHaveLength(1);
      });
    });
  });

  describe('Given a whitespace-only modify with recursive:true and ignoreWhitespace:all', () => {
    describe('When diffTrees is called', () => {
      it('Then the ws-only nested modify is dropped (mode composes with recursive)', async () => {
        // Arrange — nested blob differs only by whitespace
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'a b\n');
        const newId = await blob(ctx, 'a  b\n');
        const before = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'f.txt', oldId, FILE_MODE.REGULAR),
          ),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'f.txt', newId, FILE_MODE.REGULAR),
          ),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          recursive: true,
          ignoreWhitespace: 'all',
        });

        // Assert — dropped
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a whitespace-only modify with ignoreWhitespace:all and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the ws-only modify is dropped even with withStat (dropped file not in changes)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — dropped file absent entirely (not a 0/0 row)
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a real modify with withStat:true and ignoreWhitespace:all', () => {
    describe('When diffTrees is called', () => {
      it('Then the stat counts reflect the mode (ws-normalized counts)', async () => {
        // Arrange — one real line change + one ws-only line
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'real old\nhello world\n');
        const newId = await blob(ctx, 'real new\nhello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — only the real line is counted (ws line is common under mode 'all')
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given a type-change with identical content, ignoreWhitespace:all, and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the type-change is never dropped (dropVerdict is type-gated, not just added/deleted/binary)', async () => {
        // Arrange — same content on both sides (added=0, deleted=0, binary=false),
        // only the mode differs (regular -> symlink); withStat:true routes through
        // applyStatPass, which calls dropVerdict directly for every file (unlike the
        // streaming predicate path, which filters non-modify changes before ever
        // reaching dropVerdict)
        const ctx = await buildSeededContext();
        const fileId = await blob(ctx, '   ');
        const linkId = await blob(ctx, '   ');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'x', fileId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.SYMLINK, 'x', linkId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — type-change survives despite added===0 && deleted===0 && !binary
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('type-change');
      });
    });
  });

  describe('Given a pure-deletion modify (added=0, deleted>0), ignoreWhitespace:all, and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the modify is kept (dropVerdict sees the deleted line via the scanner, not stat counts)', async () => {
        // Arrange — one line removed, nothing added; withStat:true routes through
        // applyStatPass so dropVerdict's own scanner ladder (not the added/deleted
        // counts computed alongside it for the stat surface) decides the verdict
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'a\nXYZ\n');
        const newId = await blob(ctx, 'a\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — kept, with the real deleted count intact
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          added: 0,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given a whitespace-only modify whose two sides together exceed MAX_DIFF_LINES, and withStat:true', () => {
    describe('When diffTrees is called with ignoreWhitespace:all', () => {
      it('Then the modify is dropped (the stat arm never runs diffLines to decide the verdict)', async () => {
        // Arrange — MAX_DIFF_LINES/2 + 1 lines per side, so the combined line count
        // exceeds MAX_DIFF_LINES and diffLines (if it still fed the verdict) would
        // degrade to its whole-file fallback with added===deleted===lineCount
        const ctx = await buildSeededContext();
        const lineCount = MAX_DIFF_LINES / 2 + 1;
        const filler = 'x\n'.repeat(lineCount - 1);
        const oldId = await blob(ctx, `mid line\n${filler}`);
        const newId = await blob(ctx, `mid  line\n${filler}`);
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a real modify whose two sides together exceed MAX_DIFF_LINES, and withStat:true', () => {
    describe('When diffTrees is called with ignoreWhitespace:all', () => {
      it('Then the modify survives with real counts (edit distance is tiny, so diffLines no longer degrades)', async () => {
        // Arrange — same shape as the ws-only case above, but the first line's
        // content genuinely differs (not whitespace-only), so the file must
        // survive. There is no more size-based diffLines cap: the filler is
        // identical on both sides, so the true edit distance is 2 (one delete,
        // one insert), far under the edit-distance bail, and the counts reflect
        // that single-line change rather than a whole-file replace.
        const ctx = await buildSeededContext();
        const lineCount = MAX_DIFF_LINES / 2 + 1;
        const filler = 'x\n'.repeat(lineCount - 1);
        const oldId = await blob(ctx, `mid line\n${filler}`);
        const newId = await blob(ctx, `CHANGED\n${filler}`);
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — real single-line counts, not a whole-file replace
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given a NUL-bearing modify whose text otherwise differs only by whitespace, and withStat:true', () => {
    describe('When diffTrees is called with ignoreWhitespace:all', () => {
      it('Then the modify is kept (a binary side is never dropped on the stat arm either)', async () => {
        // Arrange — NUL forces binary detection on both sides; the only textual
        // difference besides the NUL is whitespace
        const ctx = await buildSeededContext();
        const oldId = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([104, 101, 108, 108, 111, 0, 32, 119, 111, 114, 108, 100]),
          id: '' as ObjectId,
        });
        const newId = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([104, 101, 108, 108, 111, 0, 32, 32, 119, 111, 114, 108, 100]),
          id: '' as ObjectId,
        });
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]?.type).toBe('modify');
      });
    });
  });

  describe('Given no mode and no withStat and blobs in trees', () => {
    describe('When diffTrees is called', () => {
      it('Then no blob reads occur (OID-only fast path)', async () => {
        // Arrange — instrument the context to track fs reads
        const base = await buildSeededContext();
        const { ctx, calls } = instrumentedContext(base);
        const oldId = await blob(base, 'hello\n');
        const newId = await blob(base, 'world\n');
        const before = await writeTree(base, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(base, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act — reset call log then call diffTrees with no options
        const readsBefore = calls().length;
        const result = await diffTrees(ctx, before, after);

        // Assert — reads after diffTrees are only tree reads (objects for the
        // tree entries), never blob content reads for f.txt
        const readsAfter = calls().length;
        expect(readsAfter - readsBefore).toBeGreaterThan(0); // tree reads occurred
        expect(result.changes).toHaveLength(1);

        // The key assertion: OIDs are present without any stat/line-diff
        expect(result.changes[0]).not.toHaveProperty('added');
        expect(result.changes[0]).not.toHaveProperty('binary');

        // Confirm no blob read for the blob content by checking change has oids only
        const change = result.changes[0];
        if (change?.type === 'modify') {
          expect(change.oldId).toBe(oldId);
          expect(change.newId).toBe(newId);
        }
      });
    });
  });

  describe('Given withStat:true and a textconv driver that collapses multi-line content to one line', () => {
    describe('When diffTrees is called', () => {
      it('Then stat counts reflect the textconv-transformed content (applyTextconv:true is forwarded)', async () => {
        // Arrange — rawOld has 3 lines; rawNew has 1 line. Without textconv:
        //   added=1, deleted=3. The fake textconv driver collapses BOTH sides to a
        //   single line each (different values), so with textconv: added=1, deleted=1.
        //   This distinguishes the two code paths.
        const enc = new TextEncoder();
        const rawOld = enc.encode('line1\nline2\nline3\n');
        const rawNew = enc.encode('only\n');
        // Textconv always collapses to one line regardless of raw content.
        const collapsedOld = enc.encode('COLLAPSED_OLD\n');
        const collapsedNew = enc.encode('COLLAPSED_NEW\n');

        const runner: CommandRunner = {
          run: async (req) => {
            // The command is `<textconv-cmd> <tmpPath>`. The tmp path embeds the
            // side token (old_ or new_) so we can distinguish which side is being
            // transformed without reading the file.
            const stdout = req.command.includes('old_') ? collapsedOld : collapsedNew;
            return { exitCode: 0, stdout };
          },
        };

        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.dat diff=collapse\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "collapse"]\n\ttextconv = collapse-cmd\n',
        );

        const writeBlobId = async (content: Uint8Array): Promise<ObjectId> =>
          writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });

        const oldBlobId = await writeBlobId(rawOld);
        const newBlobId = await writeBlobId(rawNew);
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', oldBlobId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', newBlobId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { withStat: true });

        // Assert — textconv collapses both sides to 1 line each → added=1, deleted=1.
        // Without textconv (applyTextconv:false / {}): rawOld=3 lines, rawNew=1 line
        // → added=1, deleted=3. The textconv path uniquely produces deleted=1.
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  // --- numstatBinaryOverride threading via diff attribute ---

  describe('Given a modify change with -diff attribute and withStat: true', () => {
    describe('When diffTrees is called with withStat: true', () => {
      it('Then the change has binary: true and added/deleted: 0 (numstatBinaryOverride=binary reaches computeStatFields)', async () => {
        // Arrange — -diff attribute forces binary on numstat surface
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.dat -diff\n');
        const enc = new TextEncoder();
        const writeBlobId = async (content: Uint8Array): Promise<ObjectId> =>
          writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
        const oldId = await writeBlobId(enc.encode('line-a\nline-b\n'));
        const newId = await writeBlobId(enc.encode('line-x\nline-y\n'));
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { withStat: true });

        // Assert — numstatBinaryOverride=binary forces binary row
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          added: 0,
          deleted: 0,
          binary: true,
        });
      });
    });
  });

  describe('Given a modify change with bare diff attribute (force text) and NUL content, withStat: true', () => {
    describe('When diffTrees is called with withStat: true', () => {
      it('Then the change has binary: false (numstatBinaryOverride=text suppresses isBinary sniff)', async () => {
        // Arrange — bare diff forces text, even though content has NUL bytes
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'g diff\n');
        const NUL_OLD = new Uint8Array([0x61, 0x00, 0x0a]); // "a\0\n"
        const NUL_NEW = new Uint8Array([0x62, 0x00, 0x0a]); // "b\0\n"
        const writeBlobId = async (content: Uint8Array): Promise<ObjectId> =>
          writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
        const oldId = await writeBlobId(NUL_OLD);
        const newId = await writeBlobId(NUL_NEW);
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'g', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'g', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { withStat: true });

        // Assert — forced-text: binary: false (override suppresses NUL detection)
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          binary: false,
        });
      });
    });
  });

  describe('Given a modify change with -diff attribute and withStat: true with lineKey active', () => {
    describe('When diffTrees is called with ignoreWhitespace: all and content differs only in spaces', () => {
      it('Then the change is NOT dropped (forced-binary modify is kept even when whitespace-only diff)', async () => {
        // Arrange — whitespace-only content: without -diff the lineKey pass would drop this;
        // with -diff the forced-binary override sets numstatBinaryOverride='binary', so
        // dropVerdict returns false (kept) before the scanner ever runs
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.dat -diff\n');
        const enc = new TextEncoder();
        const writeBlobId = async (content: Uint8Array): Promise<ObjectId> =>
          writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
        // Blobs differ only in whitespace (spaces vs tabs) — distinct OIDs
        const oldId = await writeBlobId(enc.encode('hello world\n'));
        const newId = await writeBlobId(enc.encode('hello  world\n')); // extra space
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', newId)]);

        // Act — ignoreWhitespace:all would drop a whitespace-only text change; -diff makes it binary
        const result = await diffTrees(ctx, before, after, {
          withStat: true,
          ignoreWhitespace: 'all',
        });

        // Assert — forced-binary is never dropped (binary: true, added=0, deleted=0 kept)
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          added: 0,
          deleted: 0,
          binary: true,
        });
      });
    });
  });

  describe('Given a bare-diff-attribute modify over NUL content whose change is whitespace-only', () => {
    // Real git (`f.bin diff`, `hello\0world  \n` -> `hello\0world\t\n`):
    // `git diff -w --name-only` is empty and `git diff --name-only` lists the
    // file — the forced-text attribute suppresses the NUL sniff on the drop
    // verdict exactly as it already does on the numstat counts.
    const forceTextNulTrees = async (): Promise<{
      readonly ctx: Ctx;
      readonly before: ObjectId;
      readonly after: ObjectId;
    }> => {
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f.bin diff\n');
      const writeBlobId = async (content: Uint8Array): Promise<ObjectId> =>
        writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
      // "hello\0world  \n" -> "hello\0world\t\n"
      const oldId = await writeBlobId(
        new Uint8Array([
          0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x20, 0x20, 0x0a,
        ]),
      );
      const newId = await writeBlobId(
        new Uint8Array([
          0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x09, 0x0a,
        ]),
      );
      const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.bin', oldId)]);
      const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.bin', newId)]);
      return { ctx, before, after };
    };

    describe('When diffTrees is called with ignoreWhitespace:all and withStat:true', () => {
      it('Then the change is dropped (the forced-text attribute suppresses the NUL rule on the stat path)', async () => {
        // Arrange
        const { ctx, before, after } = await forceTextNulTrees();

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });

    describe('When diffTrees is called with ignoreWhitespace:all and withStat omitted', () => {
      it('Then the change is dropped (the forced-text attribute suppresses the NUL rule on the predicate path)', async () => {
        // Arrange
        const { ctx, before, after } = await forceTextNulTrees();

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });

    describe('When diffTrees is called without a whitespace mode and withStat:true', () => {
      it('Then the change survives with real line counts (the attribute forces text, so no binary row)', async () => {
        // Arrange
        const { ctx, before, after } = await forceTextNulTrees();

        // Act
        const result = await diffTrees(ctx, before, after, { withStat: true });

        // Assert
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given a whitespace-only modify with ignoreWhitespace:all and withStat omitted', () => {
    describe('When diffTrees is called', () => {
      it('Then the modify is dropped WITHOUT materialising blobs (streaming predicate)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);
        const materialiseSpy = vi.spyOn(materialisePatchFilesMod, 'materialisePatchFiles');

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — dropped via the streaming predicate; the full materialise pass never ran
        expect(result.changes).toHaveLength(0);
        expect(materialiseSpy).not.toHaveBeenCalled();

        materialiseSpy.mockRestore();
      });
    });
  });

  describe('Given a whitespace-only modify beside a real modify, ignoreWhitespace:all and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the counts are computed only for the surviving file (the dropped one costs no line diff)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const wsOld = await blob(ctx, 'hello world\n');
        const wsNew = await blob(ctx, 'hello  world\n');
        const realOld = await blob(ctx, 'alpha\n');
        const realNew = await blob(ctx, 'beta\n');
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'real.txt', realOld),
          treeEntry(FILE_MODE.REGULAR, 'ws.txt', wsOld),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'real.txt', realNew),
          treeEntry(FILE_MODE.REGULAR, 'ws.txt', wsNew),
        ]);
        const statFieldsSpy = vi.spyOn(statFieldsMod, 'computeStatFields');

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert — one surviving change, and exactly one line-diff pass: the
        // dropped file's counts would have been discarded, so they are never
        // computed (the call that DID happen proves the spy is wired).
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({ type: 'modify', path: 'real.txt' });
        expect(statFieldsSpy).toHaveBeenCalledTimes(1);

        statFieldsSpy.mockRestore();
      });
    });
  });

  describe('Given a whitespace-only change on a very long unterminated line', () => {
    describe('When diffTrees is called with ignoreWhitespace:all and withStat omitted', () => {
      it('Then the file is dropped, like git', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const longLine = 'x'.repeat(70_000);
        const oldId = await blob(ctx, `${longLine} a`);
        const newId = await blob(ctx, `${longLine}  a`);
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'big.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'big.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a real (non-whitespace-only) modify with ignoreWhitespace:all and withStat omitted', () => {
    describe('When diffTrees is called', () => {
      it('Then the modify survives WITHOUT materialising blobs (streaming predicate)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello\n');
        const newId = await blob(ctx, 'world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);
        const materialiseSpy = vi.spyOn(materialisePatchFilesMod, 'materialisePatchFiles');

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — real content change survives; the full materialise pass never ran
        expect(result.changes).toHaveLength(1);
        expect(materialiseSpy).not.toHaveBeenCalled();

        materialiseSpy.mockRestore();
      });
    });
  });

  describe('Given a whitespace-only modify with ignoreWhitespace:all and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then materialisePatchFiles IS called (the stat path keeps the full pass)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);
        const materialiseSpy = vi.spyOn(materialisePatchFilesMod, 'materialisePatchFiles');

        // Act
        await diffTrees(ctx, before, after, { ignoreWhitespace: 'all', withStat: true });

        // Assert
        expect(materialiseSpy).toHaveBeenCalled();

        materialiseSpy.mockRestore();
      });
    });
  });

  describe('Given the whitespace drop verdict across every LineKey × ignoreBlankLines combination', () => {
    describe('When diffTrees is called with withStat omitted vs withStat:true', () => {
      const enc = new TextEncoder();
      const REAL_CHANGE = {
        oldBytes: enc.encode('real one\n'),
        newBytes: enc.encode('real two\n'),
      };

      const wsOnlyPairFor = (
        mode: WhitespaceMode,
        ignoreCrAtEol: boolean,
      ): { readonly oldBytes: Uint8Array; readonly newBytes: Uint8Array } => {
        if (mode === 'all')
          return { oldBytes: enc.encode('a b\n'), newBytes: enc.encode('a  b\n') };
        if (mode === 'change') {
          return { oldBytes: enc.encode('a b\n'), newBytes: enc.encode('a    b\n') };
        }
        if (mode === 'at-eol')
          return { oldBytes: enc.encode('a\n'), newBytes: enc.encode('a   \n') };
        // mode 'none' only routes through the predicate when ignoreCrAtEol is active.
        return ignoreCrAtEol
          ? { oldBytes: enc.encode('a\r\n'), newBytes: enc.encode('a\n') }
          : REAL_CHANGE;
      };

      const ACTIVE_KEYS: ReadonlyArray<LineKey> = [
        { mode: 'all', ignoreCrAtEol: false },
        { mode: 'all', ignoreCrAtEol: true },
        { mode: 'change', ignoreCrAtEol: false },
        { mode: 'change', ignoreCrAtEol: true },
        { mode: 'at-eol', ignoreCrAtEol: false },
        { mode: 'at-eol', ignoreCrAtEol: true },
        { mode: 'none', ignoreCrAtEol: true },
      ];

      const matrix = ACTIVE_KEYS.flatMap((key) =>
        [true, false].map((ignoreBlankLines) => ({ key, ignoreBlankLines })),
      );

      it.each(matrix)(
        'Then the predicate path and the stat path agree ($key.mode/crAtEol=$key.ignoreCrAtEol/blank=$ignoreBlankLines)',
        async ({ key, ignoreBlankLines }) => {
          // Arrange
          const wsOnly = wsOnlyPairFor(key.mode, key.ignoreCrAtEol);
          const options = {
            ...(key.mode !== 'none' ? { ignoreWhitespace: key.mode } : {}),
            ...(key.ignoreCrAtEol ? { ignoreCrAtEol: true } : {}),
            ...(ignoreBlankLines ? { ignoreBlankLines: true } : {}),
          };

          for (const pair of [wsOnly, REAL_CHANGE]) {
            const ctx = await buildSeededContext();
            const oldId = await writeObject(ctx, {
              type: 'blob',
              content: pair.oldBytes,
              id: '' as ObjectId,
            });
            const newId = await writeObject(ctx, {
              type: 'blob',
              content: pair.newBytes,
              id: '' as ObjectId,
            });
            const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
            const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

            // Act
            const predicateResult = await diffTrees(ctx, before, after, options);
            const statResult = await diffTrees(ctx, before, after, { ...options, withStat: true });

            // Assert — same survivor count from both paths
            expect(predicateResult.changes.length).toBe(statResult.changes.length);
          }
        },
      );
    });
  });

  describe('Given a blank-only line insert under ignoreWhitespace:all with ignoreBlankLines', () => {
    describe('When diffTrees is called with withStat omitted vs withStat:true', () => {
      it('Then both paths drop the change (blank insert is insignificant under all four flags)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello\n');
        const newId = await blob(ctx, 'hello\n   \n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);
        const options = { ignoreWhitespace: 'all' as const, ignoreBlankLines: true };

        // Act
        const predicateResult = await diffTrees(ctx, before, after, options);
        const statResult = await diffTrees(ctx, before, after, { ...options, withStat: true });

        // Assert
        expect(predicateResult.changes).toHaveLength(0);
        expect(statResult.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a blank-only line insert under ignoreWhitespace:all WITHOUT ignoreBlankLines', () => {
    describe('When diffTrees is called with withStat omitted vs withStat:true', () => {
      it('Then both paths keep the change (blank-line count is significant without ignoreBlankLines)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello\n');
        const newId = await blob(ctx, 'hello\n\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);
        const options = { ignoreWhitespace: 'all' as const };

        // Act
        const predicateResult = await diffTrees(ctx, before, after, options);
        const statResult = await diffTrees(ctx, before, after, { ...options, withStat: true });

        // Assert
        expect(predicateResult.changes).toHaveLength(1);
        expect(statResult.changes).toHaveLength(1);
      });
    });
  });

  describe('Given a non-recursive diff where a sub-directory changed (tree-oid modify) and ignoreWhitespace is set', () => {
    describe('When diffTrees is called without recursive', () => {
      it('Then the tree-oid modify is dropped instead of crashing (directory pairs cannot be line-diffed, matching `git diff-tree -w`)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subBefore = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'old content\n'),
          FILE_MODE.REGULAR,
        );
        const subAfter = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'new content\n'),
          FILE_MODE.REGULAR,
        );
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subBefore)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subAfter)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a non-recursive diff mixing a tree-oid modify (sub-directory) and a real top-level file change, with ignoreWhitespace set', () => {
    describe('When diffTrees is called', () => {
      it('Then only the tree-oid modify is dropped; the top-level file change survives', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subBefore = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'old\n'),
          FILE_MODE.REGULAR,
        );
        const subAfter = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'new\n'),
          FILE_MODE.REGULAR,
        );
        const oldFileId = await blob(ctx, 'alpha\n');
        const newFileId = await blob(ctx, 'beta\n');
        const before = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'root.txt', oldFileId),
          treeEntry(FILE_MODE.DIRECTORY, 'sub', subBefore),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'root.txt', newFileId),
          treeEntry(FILE_MODE.DIRECTORY, 'sub', subAfter),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'root.txt',
            oldId: oldFileId,
            newId: newFileId,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given a non-recursive diff where a whole new sub-directory was added (tree-oid add) and ignoreWhitespace is set', () => {
    describe('When diffTrees is called without recursive', () => {
      it('Then the tree-oid add is dropped (matching `git diff-tree -w`, which never shows a directory-mode entry)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subId = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'line1\n'),
          FILE_MODE.REGULAR,
        );
        const empty = await writeTree(ctx, []);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);

        // Act
        const result = await diffTrees(ctx, empty, withSub, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a non-recursive diff where a whole sub-directory was deleted (tree-oid delete) and ignoreWhitespace is set', () => {
    describe('When diffTrees is called without recursive', () => {
      it('Then the tree-oid delete is dropped (matching `git diff-tree -w`, which never shows a directory-mode entry)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subId = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'line1\n'),
          FILE_MODE.REGULAR,
        );
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);
        const empty = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, withSub, empty, { ignoreWhitespace: 'all' });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a non-recursive diff where a sub-directory changed (tree-oid modify) and withStat:true', () => {
    describe('When diffTrees is called without recursive', () => {
      it('Then the tree-oid modify is expanded into the real full-path leaf change with line counts (matching `git diff-tree --numstat`, which auto-recurses)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subBefore = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'old content\n'),
          FILE_MODE.REGULAR,
        );
        const subAfter = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'new content\n'),
          FILE_MODE.REGULAR,
        );
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subBefore)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subAfter)]);

        // Act
        const result = await diffTrees(ctx, before, after, { withStat: true });

        // Assert
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          path: 'sub/inner.txt',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given a non-recursive diff where a whole new sub-directory was added and withStat:true', () => {
    describe('When diffTrees is called without recursive', () => {
      it('Then the tree-oid add is expanded into per-file leaf adds with line counts (matching `git diff-tree --numstat`)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const aId = await blob(ctx, 'line1\n');
        const bId = await blob(ctx, 'line2\n');
        const subId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt', aId),
          treeEntry(FILE_MODE.REGULAR, 'b.txt', bId),
        ]);
        const empty = await writeTree(ctx, []);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);

        // Act
        const result = await diffTrees(ctx, empty, withSub, { withStat: true });

        // Assert
        expect(result.changes).toHaveLength(2);
        expect(result.changes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'add',
              newPath: 'sub/a.txt',
              added: 1,
              deleted: 0,
              binary: false,
            }),
            expect.objectContaining({
              type: 'add',
              newPath: 'sub/b.txt',
              added: 1,
              deleted: 0,
              binary: false,
            }),
          ]),
        );
      });
    });
  });

  describe('Given a non-recursive diff where a whole sub-directory was deleted and withStat:true', () => {
    describe('When diffTrees is called without recursive', () => {
      it('Then the tree-oid delete is expanded into per-file leaf deletes with line counts (matching `git diff-tree --numstat`)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const aId = await blob(ctx, 'line1\n');
        const bId = await blob(ctx, 'line2\n');
        const subId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt', aId),
          treeEntry(FILE_MODE.REGULAR, 'b.txt', bId),
        ]);
        const withSub = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subId)]);
        const empty = await writeTree(ctx, []);

        // Act
        const result = await diffTrees(ctx, withSub, empty, { withStat: true });

        // Assert
        expect(result.changes).toHaveLength(2);
        expect(result.changes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'delete',
              oldPath: 'sub/a.txt',
              added: 0,
              deleted: 1,
              binary: false,
            }),
            expect.objectContaining({
              type: 'delete',
              oldPath: 'sub/b.txt',
              added: 0,
              deleted: 1,
              binary: false,
            }),
          ]),
        );
      });
    });
  });

  describe('Given a non-recursive diff where a sub-directory changed with real content, ignoreWhitespace:all and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the change survives expanded with real counts (matching `git diff-tree -w --numstat`, which recurses then keeps the real change)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subBefore = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'old content\n'),
          FILE_MODE.REGULAR,
        );
        const subAfter = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'new content\n'),
          FILE_MODE.REGULAR,
        );
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subBefore)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subAfter)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({
          type: 'modify',
          path: 'sub/inner.txt',
          added: 1,
          deleted: 1,
          binary: false,
        });
      });
    });
  });

  describe('Given a non-recursive diff where a sub-directory changed only by whitespace, ignoreWhitespace:all and withStat:true', () => {
    describe('When diffTrees is called', () => {
      it('Then the expanded leaf change is dropped (0 changes), not left as an unexpanded tree-oid entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subBefore = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'hello world\n'),
          FILE_MODE.REGULAR,
        );
        const subAfter = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'hello  world\n'),
          FILE_MODE.REGULAR,
        );
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subBefore)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', subAfter)]);

        // Act
        const result = await diffTrees(ctx, before, after, {
          ignoreWhitespace: 'all',
          withStat: true,
        });

        // Assert
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  // --- attribute-marked drop predicate, no withStat (materialisedShouldDrop unit coverage) ---

  describe('Given a modify change with a -diff attribute, ignoreWhitespace:all and withStat omitted', () => {
    describe('When diffTrees is called', () => {
      it('Then the change is kept (materialised attribute verdict overrides the streaming whitespace-only drop)', async () => {
        // Arrange — -diff forces numstatBinaryOverride='binary'; dropVerdict never
        // drops when that override is set, so the materialised path must KEEP this
        // pair even though its raw bytes are whitespace-only (which the streaming
        // predicate, blind to attributes, would otherwise drop).
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f.txt -diff\n');
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — kept: -diff's binary override makes dropVerdict's numstatBinaryOverride guard fire
        expect(result.changes).toHaveLength(1);
      });
    });
  });

  describe('Given a bare-diff-attribute modify change whose whitespace-only verdict depends on lineKey normalization, withStat omitted', () => {
    describe('When diffTrees is called with ignoreWhitespace:all', () => {
      it('Then the change is dropped (materialisedShouldDrop forwards lineKeyActive into the stat pass)', async () => {
        // Arrange — bare diff forces text (non-binary), so dropVerdict's verdict here
        // hinges entirely on whether the lineKey normalization was actually applied.
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f.txt diff\n');
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — dropped: whitespace-only under normalization, forced non-binary
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  describe('Given a diff=collapse attribute with a textconv driver that converges divergent content, withStat omitted', () => {
    describe('When diffTrees is called with ignoreWhitespace:all', () => {
      it('Then the change is dropped (materialised textconv content is used, not the raw streaming bytes)', async () => {
        // Arrange — raw content is a genuine difference (not whitespace-only); the
        // textconv driver collapses BOTH sides to the identical bytes, so only the
        // materialised (applyTextconv:true) path can conclude "dropped" here — the
        // streaming predicate never applies textconv at all.
        const collapsed = new TextEncoder().encode('same\n');
        const runner: CommandRunner = { run: async () => ({ exitCode: 0, stdout: collapsed }) };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.dat diff=collapse\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "collapse"]\n\ttextconv = collapse-cmd\n',
        );
        const oldId = await blob(ctx, 'apple\n');
        const newId = await blob(ctx, 'banana\n');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', oldId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'file.dat', newId)]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — dropped: textconv output is byte-identical on both sides
        expect(result.changes).toHaveLength(0);
      });
    });
  });

  // --- withPrefix identity short-circuit ---

  describe('Given recursive=true and the raw merge-join yields a change at the root (prefix is empty)', () => {
    describe('When diffTrees is called', () => {
      it('Then the change is returned as the exact same object (withPrefix short-circuits, no reconstruction)', async () => {
        // Arrange — mock the raw merge-join to return a known object reference; withPrefix('')
        // is documented as a no-op, so the returned change must be THAT reference, not a
        // structurally-equal `{...change}` copy.
        const ctx = await buildSeededContext();
        const before = await writeTree(ctx, []);
        const after = await writeTree(ctx, []);
        const sentinelChange = {
          type: 'add' as const,
          newPath: 'f.txt' as FilePath,
          newId: 'a'.repeat(40) as ObjectId,
          newMode: FILE_MODE.REGULAR,
        };
        const spy = vi
          .spyOn(rawTreeDiffMod, 'diffRawTrees')
          .mockReturnValue({ changes: [sentinelChange] });

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(result.changes[0]).toBe(sentinelChange);
        spy.mockRestore();
      });
    });
  });

  // --- recursion safety rails: depth cap and cycle detection ---

  describe('Given a repository configured with core.maxTreeDepth = 4', () => {
    describe('When a recursive directory-modify chain is driven at depth 4', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const { oldId, newId } = await buildRealModifyChain(ctx, 5);

        // Act
        const result = await diffTrees(ctx, oldId, newId, { recursive: true });

        // Assert
        expect(result.changes).toHaveLength(1);
      });
    });

    describe('When a recursive directory-modify chain is driven at depth 5', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 5 (the guard fires before reading the phantom level)', async () => {
        // Arrange — the innermost entry points to a phantom (never-written) id
        // on each side, so the depth guard must throw before diffChangedSubtree
        // ever attempts to read it.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const { oldId, newId } = await buildPhantomModifyChain(ctx, 5);

        // Act + Assert
        try {
          await diffTrees(ctx, oldId, newId, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(5);
        }
      });
    });
  });

  describe('Given a repository configured with core.maxTreeDepth = 4 and a directory-modify chain 20x past the cap', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 5, not the deeper structural depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const { oldId, newId } = await buildPhantomModifyChain(ctx, 80);

        // Act + Assert
        try {
          await diffTrees(ctx, oldId, newId, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(5);
        }
      });
    });
  });

  describe('Given the same depth-5 directory-modify chain tested at two different core.maxTreeDepth values', () => {
    describe('When core.maxTreeDepth = 4', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const { oldId, newId } = await buildRealModifyChain(ctx, 5);

        // Act
        const result = await diffTrees(ctx, oldId, newId, { recursive: true });

        // Assert
        expect(result.changes).toHaveLength(1);
      });
    });

    describe('When core.maxTreeDepth = 3', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 4', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '3');
        const { oldId, newId } = await buildRealModifyChain(ctx, 5);

        // Act + Assert
        try {
          await diffTrees(ctx, oldId, newId, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(4);
        }
      });
    });
  });

  // --- the added/deleted-subtree expansion (walkRawSubtree) takes the same
  // resolved cap ---

  describe('Given a repository configured with core.maxTreeDepth = 4 and a newly ADDED directory nested 4 levels deep', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const oldRoot = await writeTree(ctx, []);
        const addedId = await buildDirectoryChain(ctx, 4);
        const newRoot = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'added', addedId)]);

        // Act
        const result = await diffTrees(ctx, oldRoot, newRoot, { recursive: true });

        // Assert
        expect(result.changes).toHaveLength(1);
      });
    });
  });

  describe('Given a repository configured with core.maxTreeDepth = 4 and a newly ADDED directory nested 5 levels deep', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 5', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const oldRoot = await writeTree(ctx, []);
        const addedId = await buildDirectoryChain(ctx, 5);
        const newRoot = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'added', addedId)]);

        // Act + Assert
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(5);
        }
      });
    });
  });

  describe('Given a repository configured with core.maxTreeDepth = 4 and an ADDED directory 20x past the cap', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 5, not the deeper structural depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const oldRoot = await writeTree(ctx, []);
        const addedId = await buildDirectoryChain(ctx, 80);
        const newRoot = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'added', addedId)]);

        // Act + Assert
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(5);
        }
      });
    });
  });

  describe('Given the same depth-4 ADDED directory tested at two different core.maxTreeDepth values', () => {
    describe('When core.maxTreeDepth = 4', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const oldRoot = await writeTree(ctx, []);
        const addedId = await buildDirectoryChain(ctx, 4);
        const newRoot = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'added', addedId)]);

        // Act
        const result = await diffTrees(ctx, oldRoot, newRoot, { recursive: true });

        // Assert
        expect(result.changes).toHaveLength(1);
      });
    });

    describe('When core.maxTreeDepth = 3', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 4', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '3');
        const oldRoot = await writeTree(ctx, []);
        const addedId = await buildDirectoryChain(ctx, 4);
        const newRoot = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'added', addedId)]);

        // Act + Assert
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(4);
        }
      });
    });
  });

  describe('Given a recursive diff whose old-side subtree, once read, points back to an id already on the recursion stack', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_CYCLE_DETECTED (mocking the one self-reference no real hash function can produce)', async () => {
        // Arrange — LOOP_ID's tree content lies about itself (an entry pointing back to
        // LOOP_ID). A genuine self-referential tree cannot exist in a real object store
        // (its hash would have to be a fixed point of its own content, and reads are
        // hash-verified — object-resolver.ts rejects any mismatch), so readRawObject is
        // mocked for this one id only; every other id still resolves through the real
        // implementation.
        const ctx = await buildSeededContext();
        const LOOP_ID = 'b'.repeat(40) as ObjectId;
        const loopTree: Tree = {
          type: 'tree',
          id: LOOP_ID,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'inner', LOOP_ID)],
        };
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) =>
            id === LOOP_ID ? rawTreeStub(loopTree) : realReadRawObject(spyCtx, id, options),
          );
        const distinctLeaf = await writeTree(ctx, []);
        const newLevel0 = await subTree(ctx, 'inner', distinctLeaf, FILE_MODE.DIRECTORY);
        const oldRoot = await subTree(ctx, 'sub', LOOP_ID, FILE_MODE.DIRECTORY);
        const newRoot = await subTree(ctx, 'sub', newLevel0, FILE_MODE.DIRECTORY);

        // Act
        let thrown: unknown;
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        } finally {
          spy.mockRestore();
        }

        // Assert
        const data = (thrown as { data: { code: string; id: string } }).data;
        expect(data.code).toBe('TREE_CYCLE_DETECTED');
        expect(data.id).toBe(LOOP_ID);
      });
    });
  });

  describe('Given a recursive diff whose new-side subtree, once read, points back to an id already on the recursion stack', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_CYCLE_DETECTED via the new-side guard specifically (old side never repeats)', async () => {
        // Arrange — symmetric to the old-side case, but the mocked self-reference sits
        // on the NEW side; the old side is real and non-repeating, so only the new-side
        // guard (not the old-side one) can fire here.
        const ctx = await buildSeededContext();
        const LOOP_ID = 'c'.repeat(40) as ObjectId;
        const loopTree: Tree = {
          type: 'tree',
          id: LOOP_ID,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'inner', LOOP_ID)],
        };
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) =>
            id === LOOP_ID ? rawTreeStub(loopTree) : realReadRawObject(spyCtx, id, options),
          );
        const distinctLeaf = await writeTree(ctx, []);
        const oldLevel0 = await subTree(ctx, 'inner', distinctLeaf, FILE_MODE.DIRECTORY);
        const oldRoot = await subTree(ctx, 'sub', oldLevel0, FILE_MODE.DIRECTORY);
        const newRoot = await subTree(ctx, 'sub', LOOP_ID, FILE_MODE.DIRECTORY);

        // Act
        let thrown: unknown;
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        } finally {
          spy.mockRestore();
        }

        // Assert
        const data = (thrown as { data: { code: string; id: string } }).data;
        expect(data.code).toBe('TREE_CYCLE_DETECTED');
        expect(data.id).toBe(LOOP_ID);
      });
    });
  });

  describe('Given both sides of a recursive diff independently self-reference every level (neither ever converges to add/delete)', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_CYCLE_DETECTED via the old-side guard specifically (checked before the new-side guard)', async () => {
        // Arrange — OLD_LOOP_ID and NEW_LOOP_ID each self-reference under the entry
        // name 'x', so every level stays a directory-vs-directory 'modify' and NEITHER
        // side ever degrades into an add/delete — the only route that would let
        // flattenTree's own (redundant) cycle guard mask this one. Both stacks repeat
        // at the SAME depth, so this isolates that the old-side check (checked first
        // in source order) is what actually fires — not the new-side check alone.
        const ctx = await buildSeededContext();
        const OLD_LOOP_ID = 'd'.repeat(40) as ObjectId;
        const NEW_LOOP_ID = 'e'.repeat(40) as ObjectId;
        const oldLoopTree: Tree = {
          type: 'tree',
          id: OLD_LOOP_ID,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'x', OLD_LOOP_ID)],
        };
        const newLoopTree: Tree = {
          type: 'tree',
          id: NEW_LOOP_ID,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'x', NEW_LOOP_ID)],
        };
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            if (id === OLD_LOOP_ID) {
              return rawTreeStub(oldLoopTree);
            }
            if (id === NEW_LOOP_ID) {
              return rawTreeStub(newLoopTree);
            }
            return realReadRawObject(spyCtx, id, options);
          });
        const oldRoot = await subTree(ctx, 'sub', OLD_LOOP_ID, FILE_MODE.DIRECTORY);
        const newRoot = await subTree(ctx, 'sub', NEW_LOOP_ID, FILE_MODE.DIRECTORY);

        // Act
        let thrown: unknown;
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        } finally {
          spy.mockRestore();
        }

        // Assert — old-side guard fires with the OLD id
        const data = (thrown as { data: { code: string; id: string } }).data;
        expect(data.code).toBe('TREE_CYCLE_DETECTED');
        expect(data.id).toBe(OLD_LOOP_ID);
      });
    });
  });

  describe('Given the old side repeats one level later than the new side (staggered cycles)', () => {
    describe('When diffTrees is called with recursive:true', () => {
      it('Then throws TREE_CYCLE_DETECTED via the new-side guard specifically (the old side has not repeated yet)', async () => {
        // Arrange — the old side is a genuine 2-cycle (OLD_A -> OLD_B -> OLD_A -> ...),
        // so it does NOT repeat at the first re-entry into diffChangedSubtree; the new
        // side self-references immediately every level. At the depth where the new
        // side's stack first contains its own id, the old side's stack does not yet
        // contain its own — isolating the new-side guard from the old-side one.
        const ctx = await buildSeededContext();
        const OLD_A = '1'.repeat(40) as ObjectId;
        const OLD_B = '2'.repeat(40) as ObjectId;
        const NEW_LOOP_ID = 'f'.repeat(40) as ObjectId;
        const oldATree: Tree = {
          type: 'tree',
          id: OLD_A,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'x', OLD_B)],
        };
        const oldBTree: Tree = {
          type: 'tree',
          id: OLD_B,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'x', OLD_A)],
        };
        const newLoopTree: Tree = {
          type: 'tree',
          id: NEW_LOOP_ID,
          entries: [treeEntry(FILE_MODE.DIRECTORY, 'x', NEW_LOOP_ID)],
        };
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) => {
            if (id === OLD_A) return rawTreeStub(oldATree);
            if (id === OLD_B) return rawTreeStub(oldBTree);
            if (id === NEW_LOOP_ID) {
              return rawTreeStub(newLoopTree);
            }
            return realReadRawObject(spyCtx, id, options);
          });
        const oldRoot = await subTree(ctx, 'sub', OLD_A, FILE_MODE.DIRECTORY);
        const newRoot = await subTree(ctx, 'sub', NEW_LOOP_ID, FILE_MODE.DIRECTORY);

        // Act
        let thrown: unknown;
        try {
          await diffTrees(ctx, oldRoot, newRoot, { recursive: true });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        } finally {
          spy.mockRestore();
        }

        // Assert — new-side guard fires first (old side hasn't repeated at this depth)
        const data = (thrown as { data: { code: string; id: string } }).data;
        expect(data.code).toBe('TREE_CYCLE_DETECTED');
        expect(data.id).toBe(NEW_LOOP_ID);
      });
    });
  });

  describe('Given recursive=true and a top-level blob oid (not a tree/commit/tag)', () => {
    describe('When diffTrees is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE (a blob cannot be diffed as a tree)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await blob(ctx, 'not a tree');
        const treeId = await writeTree(ctx, []);

        // Act
        let thrown: unknown;
        try {
          await diffTrees(ctx, blobId, treeId, { recursive: true });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        }

        // Assert
        const data = (thrown as { data: { code: string; expected: string; actual: string } }).data;
        expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data.expected).toBe('tree');
        expect(data.actual).toBe('blob');
      });
    });
  });

  describe('Given recursive=true and a top-level tag oid pointing directly at a tree', () => {
    describe('When diffTrees is called', () => {
      it('Then peels the tag to its tree before diffing (the tag arm of the raw peel)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await blob(ctx, 'content');
        const treeId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a.txt', fileId)]);
        const tagId = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: treeId,
            objectType: 'tree',
            tagName: 'v1',
            tagger: IDENTITY,
            message: 'tag msg',
            extraHeaders: [],
          },
        });

        // Act
        const result = await diffTrees(ctx, tagId, treeId, { recursive: true });

        // Assert — the tag peels to the SAME tree it points at, so diffing
        // it against that tree directly yields no changes.
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given recursive=true and a tag chain exceeding MAX_PEEL_DEPTH', () => {
    describe('When diffTrees is called', () => {
      it('Then throws REF_CHAIN_TOO_DEEP', async () => {
        // Arrange — mirrors read-tree.test.ts's boundary case: the peel
        // walker's depth counter is the only thing stopping runaway tag
        // resolution on the raw (diff) side too.
        const ctx = await buildSeededContext();
        const treeId = await writeTree(ctx, []);
        let currentId: ObjectId = treeId;
        let currentType: 'tree' | 'tag' = 'tree';
        for (let i = 0; i <= MAX_PEEL_DEPTH; i += 1) {
          currentId = await writeObject(ctx, {
            type: 'tag',
            id: '' as ObjectId,
            data: {
              object: currentId,
              objectType: currentType,
              tagName: `v${i}`,
              tagger: IDENTITY,
              message: `tag${i}`,
              extraHeaders: [],
            },
          });
          currentType = 'tag';
        }

        // Act + Assert
        try {
          await diffTrees(ctx, currentId, treeId, { recursive: true });
          expect.unreachable();
        } catch (error) {
          const data = (error as { data: { code: string; depth: number } }).data;
          expect(data.code).toBe('REF_CHAIN_TOO_DEEP');
          expect(data.depth).toBe(MAX_PEEL_DEPTH + 1);
        }
      });
    });
  });

  describe('Given recursive=true and a changed directory entry whose oid actually resolves to a blob', () => {
    describe('When diffTrees is called', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE on the modify route (the add/delete route silently skips instead)', async () => {
        // Arrange — `sub` is directory-mode on both sides (so the merge-join classifies
        // it as a directory `modify`), but its oid on the new side actually points at a
        // blob — diffChangedSubtree must read it raw and throw, unlike flattenTree's
        // silent skip on the add/delete route (deliberately not unified, see design).
        const ctx = await buildSeededContext();
        const oldSubId = await subTree(
          ctx,
          'inner.txt',
          await blob(ctx, 'inner'),
          FILE_MODE.REGULAR,
        );
        const notATreeId = await blob(ctx, 'not a tree');
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', oldSubId)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', notATreeId)]);

        // Act
        let thrown: unknown;
        try {
          await diffTrees(ctx, before, after, { recursive: true });
          expect.unreachable();
        } catch (error) {
          thrown = error;
        }

        // Assert
        const data = (thrown as { data: { code: string; expected: string; actual: string } }).data;
        expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data.expected).toBe('tree');
        expect(data.actual).toBe('blob');
      });
    });
  });

  describe('Given recursive=true and a 32-byte (SHA-256) HashConfig', () => {
    describe('When diffTrees is called over a nested fixture', () => {
      it('Then the raw cursor walk reads oids at the SHA-256 width, not a fixed 20 bytes', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const oldLeaf = await blob(ctx, 'old');
        const newLeaf = await blob(ctx, 'new');
        const before = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', oldLeaf, FILE_MODE.REGULAR),
          ),
        ]);
        const after = await writeTree(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await subTree(ctx, 'inner.txt', newLeaf, FILE_MODE.REGULAR),
          ),
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'sub/inner.txt',
            oldId: oldLeaf,
            newId: newLeaf,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  // --- diffRecursive: shared entry-count budget across the merge-join walk ---

  describe('Given a diamond DAG where two sibling directories reach the same changed subtree', () => {
    describe('When diffRecursive runs with a tiny injected entry cap', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED once the cumulative entry count exceeds the cap', async () => {
        // Arrange — d1 and d2 both pair the SAME old/new subtree; with no
        // memoisation the walk revisits that pair via every path that reaches
        // it, so its own change is counted once per visit.
        const ctx = await buildSeededContext();
        const oldLeaf = await blob(ctx, 'old');
        const newLeaf = await blob(ctx, 'new');
        const sharedOld = await subTree(ctx, 'leaf.txt', oldLeaf, FILE_MODE.REGULAR);
        const sharedNew = await subTree(ctx, 'leaf.txt', newLeaf, FILE_MODE.REGULAR);
        const oldRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'd1', sharedOld),
          treeEntry(FILE_MODE.DIRECTORY, 'd2', sharedOld),
        ]);
        const newRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'd1', sharedNew),
          treeEntry(FILE_MODE.DIRECTORY, 'd2', sharedNew),
        ]);
        const rawOld = (await readObjectMod.readRawObject(ctx, oldRoot)).content;
        const rawNew = (await readObjectMod.readRawObject(ctx, newRoot)).content;
        const sut = diffRecursive;

        // Act + Assert — cap=3: the root level contributes 2 (d1, d2 modify),
        // then each subtree visit contributes 1 more (leaf.txt modify); the
        // second subtree visit pushes the cumulative count to 4 > 3.
        try {
          await sut(ctx, rawOld, rawNew, 3);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(4);
          expect(data.limit).toBe(3);
        }
      });
    });

    describe('When diffRecursive runs with the cap exactly at the cumulative count', () => {
      it('Then both subtree expansions succeed', async () => {
        // Arrange — identical diamond, cap=4 (the exact cumulative count),
        // proving the guard is `count > limit`, not `>=`.
        const ctx = await buildSeededContext();
        const oldLeaf = await blob(ctx, 'old');
        const newLeaf = await blob(ctx, 'new');
        const sharedOld = await subTree(ctx, 'leaf.txt', oldLeaf, FILE_MODE.REGULAR);
        const sharedNew = await subTree(ctx, 'leaf.txt', newLeaf, FILE_MODE.REGULAR);
        const oldRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'd1', sharedOld),
          treeEntry(FILE_MODE.DIRECTORY, 'd2', sharedOld),
        ]);
        const newRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'd1', sharedNew),
          treeEntry(FILE_MODE.DIRECTORY, 'd2', sharedNew),
        ]);
        const rawOld = (await readObjectMod.readRawObject(ctx, oldRoot)).content;
        const rawNew = (await readObjectMod.readRawObject(ctx, newRoot)).content;
        const sut = diffRecursive;

        // Act
        const result = await sut(ctx, rawOld, rawNew, 4);

        // Assert
        expect(result.changes).toEqual([
          {
            type: 'modify',
            path: 'd1/leaf.txt',
            oldId: oldLeaf,
            newId: newLeaf,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          {
            type: 'modify',
            path: 'd2/leaf.txt',
            oldId: oldLeaf,
            newId: newLeaf,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given an add-diamond DAG where an added and a deleted directory both point at the same subtree', () => {
    describe('When diffRecursive runs with a tiny injected entry cap', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED counting across both subtree expansions', async () => {
        // Arrange — dAdd (new-only) and dDel (old-only) both pair the SAME
        // subtree; with no shared budget across expandAddedSubtree and
        // expandDeletedSubtree, each expansion would silently walk its own
        // full-size default budget instead of the caller's tiny cap.
        const ctx = await buildSeededContext();
        const leaf = await blob(ctx, 'shared');
        const sharedSubtree = await subTree(ctx, 'leaf.txt', leaf, FILE_MODE.REGULAR);
        const oldRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'dDel', sharedSubtree),
        ]);
        const newRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'dAdd', sharedSubtree),
        ]);
        const rawOld = (await readObjectMod.readRawObject(ctx, oldRoot)).content;
        const rawNew = (await readObjectMod.readRawObject(ctx, newRoot)).content;
        const sut = diffRecursive;

        // Act + Assert — cap=3: the root level contributes 2 (dAdd add,
        // dDel delete), then each subtree expansion contributes 1 more
        // (leaf.txt); the second expansion pushes the cumulative count to 4 > 3.
        try {
          await sut(ctx, rawOld, rawNew, 3);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(4);
          expect(data.limit).toBe(3);
        }
      });
    });
  });

  describe('Given a root level with 5 sibling leaf adds and a cap of 3', () => {
    describe('When diffRecursive runs', () => {
      it('Then reports count=4 (the cap is first exceeded at limit+1, never the full batch size)', async () => {
        // Arrange — a single merge-join level can carry a multi-entry batch;
        // the reported count must match a one-at-a-time increment-then-check
        // loop's first over-limit count, not however far a whole-batch addition
        // would overshoot by.
        const ctx = await buildSeededContext();
        const oldRoot = await writeTree(ctx, []);
        const newRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a', await blob(ctx, 'a')),
          treeEntry(FILE_MODE.REGULAR, 'b', await blob(ctx, 'b')),
          treeEntry(FILE_MODE.REGULAR, 'c', await blob(ctx, 'c')),
          treeEntry(FILE_MODE.REGULAR, 'd', await blob(ctx, 'd')),
          treeEntry(FILE_MODE.REGULAR, 'e', await blob(ctx, 'e')),
        ]);
        const rawOld = (await readObjectMod.readRawObject(ctx, oldRoot)).content;
        const rawNew = (await readObjectMod.readRawObject(ctx, newRoot)).content;
        const sut = diffRecursive;

        // Act + Assert
        try {
          await sut(ctx, rawOld, rawNew, 3);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(4);
          expect(data.limit).toBe(3);
        }
      });
    });
  });

  // --- one concurrency limiter per diff operation, shared across every
  // subtree expansion it runs (see DiffWalkState.limiter) ---

  describe('Given an added directory and a deleted directory expanded within the same diffRecursive call', () => {
    describe('When diffRecursive runs', () => {
      it('Then both walkRawSubtree calls share the identical DiffWalkState limiter instance, not one each', async () => {
        // Arrange — two DIFFERENT subtree expansions (add + delete) at the same
        // level, so `diffRecursiveLevel`'s `boundedMap` runs both concurrently.
        // A shared limiter is what makes the two expansions' COMBINED in-flight
        // object reads respect ONE bound instead of each minting its own and
        // multiplying the effective concurrency — proving both calls receive the
        // identical instance is a deterministic proxy for that property
        // (`concurrency-limiter.test.ts` already proves the limiter itself caps
        // concurrency for whoever shares it).
        const ctx = await buildSeededContext();
        const addedSubId = await subTree(ctx, 'f', await blob(ctx, 'added'), FILE_MODE.REGULAR);
        const deletedSubId = await subTree(ctx, 'f', await blob(ctx, 'deleted'), FILE_MODE.REGULAR);
        const oldRoot = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'dDel', deletedSubId),
        ]);
        const newRoot = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dAdd', addedSubId)]);
        const rawOld = (await readObjectMod.readRawObject(ctx, oldRoot)).content;
        const rawNew = (await readObjectMod.readRawObject(ctx, newRoot)).content;
        const walkSpy = vi.spyOn(walkRawSubtreeMod, 'walkRawSubtree');
        const sut = diffRecursive;

        // Act
        try {
          const result = await sut(ctx, rawOld, rawNew);

          // Assert
          expect(result.changes).toHaveLength(2);
          expect(walkSpy).toHaveBeenCalledTimes(2);
          const limiters = walkSpy.mock.calls.map((call) => call[6]);
          expect(limiters[0]).toBeDefined();
          expect(limiters[0]).toBe(limiters[1]);
        } finally {
          walkSpy.mockRestore();
        }
      });
    });
  });

  describe('Given more added top-level directories than the ioBound limit', () => {
    describe('When diffRecursive runs', () => {
      it('Then sibling directory expansions at the level peak at exactly the bound', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a
        // bucket-swap regression (deriving diffRecursiveLevel's fan-out from
        // the wrong bucket) fails loudly. Each directory is a top-level
        // 'add', so every one becomes a sibling expansion at the SAME level,
        // fanning out through `boundedMapFor` together.
        const ioBound = 3;
        const width = ioBound + 4;
        const base = await buildSeededContext();
        const entries: TreeEntry[] = [];
        for (let i = 0; i < width; i++) {
          const subId = await subTree(
            base,
            'f',
            await blob(base, `content-${i}`),
            FILE_MODE.REGULAR,
          );
          entries.push(treeEntry(FILE_MODE.DIRECTORY, `d${String(i).padStart(3, '0')}`, subId));
        }
        const oldRoot = await writeTree(base, []);
        const newRoot = await writeTree(base, entries);
        const ctx: Ctx = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const rawOld = (await readObjectMod.readRawObject(ctx, oldRoot)).content;
        const rawNew = (await readObjectMod.readRawObject(ctx, newRoot)).content;
        let inFlight = 0;
        let maxInFlight = 0;
        const realWalkRawSubtree = walkRawSubtreeMod.walkRawSubtree;
        const spy = vi
          .spyOn(walkRawSubtreeMod, 'walkRawSubtree')
          .mockImplementation(async (...args) => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
            return realWalkRawSubtree(...args);
          });
        const sut = diffRecursive;

        // Act
        try {
          const result = await sut(ctx, rawOld, rawNew);

          // Assert
          expect(result.changes).toHaveLength(width);
          expect(maxInFlight).toBe(ioBound);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
});

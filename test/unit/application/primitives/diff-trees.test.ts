import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { diffTrees } from '../../../../src/application/primitives/diff-trees.js';
import * as flattenTreeMod from '../../../../src/application/primitives/flatten-tree.js';
import * as materialisePatchFilesMod from '../../../../src/application/primitives/materialise-patch-files.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { LineKey, WhitespaceMode } from '../../../../src/domain/diff/index.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import * as encodingMod from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { Blob, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import type { CommandRunner } from '../../../../src/ports/command-runner.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';

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
          { name: 'a.txt', mode: '100644' as FileMode, id: blobId },
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
        const before = await writeTree(ctx, [
          { name: 'src.txt', mode: '100644' as FileMode, id: blobId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'dst.txt', mode: '100644' as FileMode, id: blobId },
        ]);

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
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR),
          },
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
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'inner.txt', innerId, FILE_MODE.REGULAR),
          },
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

  describe('Given recursive=true and an unchanged (TREESAME) sub-directory alongside a changed file', () => {
    describe('When diffTrees is called', () => {
      it('Then flattenTree is never invoked (the TREESAME subtree is pruned before any read)', async () => {
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
          { name: 'big', mode: FILE_MODE.DIRECTORY, id: unchangedSubId },
          { name: 'root.txt', mode: FILE_MODE.REGULAR, id: oldFileId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'big', mode: FILE_MODE.DIRECTORY, id: unchangedSubId },
          { name: 'root.txt', mode: FILE_MODE.REGULAR, id: newFileId },
        ]);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert — no subtree was ever flattened; only the differing file changed.
        expect(flattenSpy).not.toHaveBeenCalled();
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
        flattenSpy.mockRestore();
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
          manyEntries.push({
            name: `f${i}.txt`,
            mode: FILE_MODE.REGULAR,
            id: await blob(ctx, `content-${i}`),
          });
        }
        const unchangedSubId = await writeTree(ctx, manyEntries);
        const oldFileId = await blob(ctx, 'old');
        const newFileId = await blob(ctx, 'new');
        const before = await writeTree(ctx, [
          { name: 'big', mode: FILE_MODE.DIRECTORY, id: unchangedSubId },
          { name: 'root.txt', mode: FILE_MODE.REGULAR, id: oldFileId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'big', mode: FILE_MODE.DIRECTORY, id: unchangedSubId },
          { name: 'root.txt', mode: FILE_MODE.REGULAR, id: newFileId },
        ]);
        const bytesToHexSpy = vi.spyOn(encodingMod, 'bytesToHex');
        const decodeSpy = vi.spyOn(encodingMod, 'decode');

        // Act
        const result = await diffTrees(ctx, before, after, { recursive: true });

        // Assert — well under the 20-entry unchanged subtree: only the two
        // root-level trees (2 entries each side) were ever parsed (4 oid
        // conversions; 10 decodes = 2 headers + 2 mode/name pairs per tree).
        expect(result.changes).toHaveLength(1);
        expect(bytesToHexSpy.mock.calls.length).toBeLessThanOrEqual(4);
        expect(decodeSpy.mock.calls.length).toBeLessThanOrEqual(10);
        bytesToHexSpy.mockRestore();
        decodeSpy.mockRestore();
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
        const before = await writeTree(ctx, [
          { name: 'original.txt', mode: FILE_MODE.REGULAR, id: srcId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'moved.txt', mode: FILE_MODE.REGULAR, id: dstId },
        ]);

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
        const before = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
        ]);

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
          entries: [{ name: 'f.txt', mode: '100644' as FileMode, id: blobId }],
        };

        // Act
        const result = await diffTrees(ctx, treeA, treeB);

        // Assert
        expect(result.changes.length).toBe(1);
        expect(result.changes[0]?.type).toBe('add');
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
            const withEntry = await writeTree(ctx, [
              { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
            ]);
            return { before: empty, after: withEntry };
          },
          expected: { type: 'add', added: 1, deleted: 0, binary: false },
        },
        {
          label: 'modified',
          build: async (ctx: Ctx): Promise<{ before: ObjectId; after: ObjectId }> => {
            const before = await writeTree(ctx, [
              { name: 'a.txt', mode: FILE_MODE.REGULAR, id: await blob(ctx, 'a\n') },
            ]);
            const after = await writeTree(ctx, [
              { name: 'a.txt', mode: FILE_MODE.REGULAR, id: await blob(ctx, 'b\n') },
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
            const withEntry = await writeTree(ctx, [
              { name: 'a.txt', mode: FILE_MODE.REGULAR, id: blobId },
            ]);
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

        const treeA = await writeTree(ctx, [
          { name: 'orig.txt', mode: FILE_MODE.REGULAR, id: unchangedId },
        ]);
        const treeB = await writeTree(ctx, [
          { name: 'orig.txt', mode: FILE_MODE.REGULAR, id: unchangedId }, // unchanged
          { name: 'copy.txt', mode: FILE_MODE.REGULAR, id: dstId }, // new, similar to orig
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
        const treeB = await writeTree(ctx, [
          { name: 'file.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);

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
        const treeB = await writeTree(ctx, [
          { name: 'file.txt', mode: FILE_MODE.REGULAR, id: blobId },
        ]);

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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);

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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);

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
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: fOldId },
          { name: 'g.txt', mode: FILE_MODE.REGULAR, id: gOldId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: fNewId },
          { name: 'g.txt', mode: FILE_MODE.REGULAR, id: gNewId },
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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);

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
        const before = await writeTree(ctx, [{ name: 'x', mode: FILE_MODE.REGULAR, id: fileId }]);
        const after = await writeTree(ctx, [{ name: 'x', mode: FILE_MODE.SYMLINK, id: linkId }]);

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
        const before = await writeTree(ctx, [
          { name: 'src.txt', mode: FILE_MODE.REGULAR, id: srcId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'dst.txt', mode: FILE_MODE.REGULAR, id: dstId },
        ]);

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
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'f.txt', oldId, FILE_MODE.REGULAR),
          },
        ]);
        const after = await writeTree(ctx, [
          {
            name: 'sub',
            mode: FILE_MODE.DIRECTORY,
            id: await subTree(ctx, 'f.txt', newId, FILE_MODE.REGULAR),
          },
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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);

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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);

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

  describe('Given no mode and no withStat and blobs in trees', () => {
    describe('When diffTrees is called', () => {
      it('Then no blob reads occur (OID-only fast path)', async () => {
        // Arrange — instrument the context to track fs reads
        const base = await buildSeededContext();
        const { ctx, calls } = instrumentedContext(base);
        const oldId = await blob(base, 'hello\n');
        const newId = await blob(base, 'world\n');
        const before = await writeTree(base, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(base, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId },
        ]);

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
        const before = await writeTree(ctx, [
          { name: 'file.dat', mode: FILE_MODE.REGULAR, id: oldBlobId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'file.dat', mode: FILE_MODE.REGULAR, id: newBlobId },
        ]);

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
        const before = await writeTree(ctx, [
          { name: 'file.dat', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'file.dat', mode: FILE_MODE.REGULAR, id: newId },
        ]);

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
        const before = await writeTree(ctx, [{ name: 'g', mode: FILE_MODE.REGULAR, id: oldId }]);
        const after = await writeTree(ctx, [{ name: 'g', mode: FILE_MODE.REGULAR, id: newId }]);

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
        // with -diff the forced-binary override makes binary:true, so shouldDrop returns false
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.dat -diff\n');
        const enc = new TextEncoder();
        const writeBlobId = async (content: Uint8Array): Promise<ObjectId> =>
          writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
        // Blobs differ only in whitespace (spaces vs tabs) — distinct OIDs
        const oldId = await writeBlobId(enc.encode('hello world\n'));
        const newId = await writeBlobId(enc.encode('hello  world\n')); // extra space
        const before = await writeTree(ctx, [
          { name: 'file.dat', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'file.dat', mode: FILE_MODE.REGULAR, id: newId },
        ]);

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

  describe('Given a whitespace-only modify with ignoreWhitespace:all and withStat omitted', () => {
    describe('When diffTrees is called', () => {
      it('Then the modify is dropped WITHOUT materialising blobs (streaming predicate)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await blob(ctx, 'hello world\n');
        const newId = await blob(ctx, 'hello  world\n');
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);
        const materialiseSpy = vi.spyOn(materialisePatchFilesMod, 'materialisePatchFiles');

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — dropped via the streaming predicate; the full materialise pass never ran
        expect(result.changes).toHaveLength(0);
        expect(materialiseSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a single unterminated line longer than the line cap, whitespace-only change', () => {
    describe('When diffTrees is called with ignoreWhitespace:all and withStat omitted', () => {
      it('Then the file is kept (binary via the incremental cap, never buffered whole)', async () => {
        // Arrange — one 70,000-byte line with no LF: over MAX_LINE_BYTES, so
        // the predicate must flag binary from the PENDING bytes and bail early
        const ctx = await buildSeededContext();
        const longLine = 'x'.repeat(70_000);
        const oldId = await blob(ctx, `${longLine} a`);
        const newId = await blob(ctx, `${longLine}  a`);
        const before = await writeTree(ctx, [
          { name: 'big.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [
          { name: 'big.txt', mode: FILE_MODE.REGULAR, id: newId },
        ]);

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — a binary side is never dropped, matching the stat path
        expect(result.changes).toHaveLength(1);
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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);
        const materialiseSpy = vi.spyOn(materialisePatchFilesMod, 'materialisePatchFiles');

        // Act
        const result = await diffTrees(ctx, before, after, { ignoreWhitespace: 'all' });

        // Assert — real content change survives; the full materialise pass never ran
        expect(result.changes).toHaveLength(1);
        expect(materialiseSpy).not.toHaveBeenCalled();
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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);
        const materialiseSpy = vi.spyOn(materialisePatchFilesMod, 'materialisePatchFiles');

        // Act
        await diffTrees(ctx, before, after, { ignoreWhitespace: 'all', withStat: true });

        // Assert
        expect(materialiseSpy).toHaveBeenCalled();
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
            const before = await writeTree(ctx, [
              { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
            ]);
            const after = await writeTree(ctx, [
              { name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId },
            ]);

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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);
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
        const before = await writeTree(ctx, [
          { name: 'f.txt', mode: FILE_MODE.REGULAR, id: oldId },
        ]);
        const after = await writeTree(ctx, [{ name: 'f.txt', mode: FILE_MODE.REGULAR, id: newId }]);
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
        const before = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
        ]);

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
          { name: 'root.txt', mode: FILE_MODE.REGULAR, id: oldFileId },
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'root.txt', mode: FILE_MODE.REGULAR, id: newFileId },
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
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
        const withSub = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subId },
        ]);

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
        const withSub = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subId },
        ]);
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
        const before = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
        ]);

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
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: aId },
          { name: 'b.txt', mode: FILE_MODE.REGULAR, id: bId },
        ]);
        const empty = await writeTree(ctx, []);
        const withSub = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subId },
        ]);

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
          { name: 'a.txt', mode: FILE_MODE.REGULAR, id: aId },
          { name: 'b.txt', mode: FILE_MODE.REGULAR, id: bId },
        ]);
        const withSub = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subId },
        ]);
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
        const before = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
        ]);

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
        const before = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subBefore },
        ]);
        const after = await writeTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY, id: subAfter },
        ]);

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
});

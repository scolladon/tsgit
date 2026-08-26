import { describe, expect, it } from 'vitest';
import { flattenTree } from '../../../../src/application/primitives/flatten-tree.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { walkTree } from '../../../../src/application/primitives/walk-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import { encode, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import {
  buildSeededContext,
  instrumentedContext,
  seedMaxTreeDepth,
  writeRawObjectBytes,
} from './fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

const writeBlob = async (ctx: Ctx, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

/** Build a chain of `levels` nested DIRECTORY wrappers around a real leaf
 *  tree (one blob entry) — a small, config-cap-reachable stand-in for the
 *  1000+-level fixtures a hardcoded 1024/2048 cap used to require. */
const buildDirectoryChain = async (ctx: Ctx, levels: number): Promise<ObjectId> => {
  const blobId = await writeBlob(ctx, 'leaf');
  let current = await writeTree(ctx, [
    { name: 'leaf' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
  ]);
  for (let i = 0; i < levels; i++) {
    current = await writeTree(ctx, [
      { name: `d${i}` as FilePath, id: current, mode: FILE_MODE.DIRECTORY },
    ]);
  }
  return current;
};

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Hand-built raw entry bytes, bypassing `writeTree`'s canonicalising
// serializer — needed to plant an invalid name or a duplicate-name pair
// exactly as written, without `serializeTreeContent` re-sorting them.
function rawEntry(mode: string, name: string, id: ObjectId): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(id));
}

describe('flattenTree', () => {
  describe('Given an empty tree', () => {
    describe('When flattenTree runs', () => {
      it('Then returns an empty FlatTree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await writeTree(ctx, []);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.size).toBe(0);
      });
    });
  });

  describe('Given a single-file tree', () => {
    describe('When flattenTree runs', () => {
      it('Then returns one FlatTree entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.size).toBe(1);
        expect(result.entries.get('a.txt' as FilePath)).toEqual({
          id: blobId,
          mode: FILE_MODE.REGULAR,
        });
      });
    });
  });

  describe('Given a nested tree', () => {
    describe('When flattenTree runs', () => {
      it('Then leaves are keyed by canonical /-separated paths', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const subId = await writeTree(ctx, [
          { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
          { name: 'sub' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
        ]);

        // Act
        const result = await flattenTree(ctx, rootId);

        // Assert
        expect(result.entries.size).toBe(2);
        expect(result.entries.get('a.txt' as FilePath)?.id).toBe(idA);
        expect(result.entries.get('sub/inner.txt' as FilePath)?.id).toBe(idB);
      });
    });
  });

  describe('Given a tree containing an executable file and a symlink', () => {
    describe('When flattenTree runs', () => {
      it('Then modes are preserved', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const execId = await writeBlob(ctx, '#!/bin/sh');
        const linkId = await writeBlob(ctx, 'target/path');
        const treeId = await writeTree(ctx, [
          { name: 'run.sh' as FilePath, id: execId, mode: FILE_MODE.EXECUTABLE },
          { name: 'link' as FilePath, id: linkId, mode: FILE_MODE.SYMLINK },
        ]);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.get('run.sh' as FilePath)?.mode).toBe(FILE_MODE.EXECUTABLE);
        expect(result.entries.get('link' as FilePath)?.mode).toBe(FILE_MODE.SYMLINK);
      });
    });
  });

  describe('Given a tree nested two levels deep', () => {
    describe('When flattenTree runs', () => {
      it('Then leaves are keyed by full slash-joined path', async () => {
        // Arrange — root → dir/ → sub/ → leaf.txt. Pins the slash separator
        // at every recursion depth, including the second nested level.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'deep');
        const subTreeId = await writeTree(ctx, [
          { name: 'leaf.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);
        const dirTreeId = await writeTree(ctx, [
          { name: 'sub' as FilePath, id: subTreeId, mode: FILE_MODE.DIRECTORY },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'dir' as FilePath, id: dirTreeId, mode: FILE_MODE.DIRECTORY },
        ]);

        // Act
        const result = await flattenTree(ctx, rootId);

        // Assert — only one leaf, with the full 2-level path.
        expect(result.entries.size).toBe(1);
        expect(result.entries.get('dir/sub/leaf.txt' as FilePath)?.id).toBe(blobId);
      });
    });
  });

  describe('Given a resolved Tree object instead of an oid', () => {
    describe('When flattenTree runs on the object and on its oid', () => {
      it('Then both results are identical', async () => {
        // Arrange — a nested tree, then read it back as a Tree object.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const subId = await writeTree(ctx, [
          { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
          { name: 'sub' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
        ]);
        const rootObject = (await readObject(ctx, rootId)) as Tree;

        // Act
        const fromObject = await flattenTree(ctx, rootObject);
        const fromOid = await flattenTree(ctx, rootId);

        // Assert — same leaves, same keys. The root is read raw by its `id`
        // either way (a `Tree` object is not walked directly).
        expect([...fromObject.entries]).toEqual([...fromOid.entries]);
        expect(fromObject.entries.get('sub/inner.txt' as FilePath)?.id).toBe(idB);
      });
    });
  });

  describe('Given a tree containing a gitlink', () => {
    describe('When flattenTree runs', () => {
      it('Then the gitlink entry is preserved (mode = GITLINK)', async () => {
        // Arrange — gitlink at a leaf records the submodule commit oid.
        // mergeTrees treats gitlinks specially (any divergence is a conflict),
        // so flattenTree must preserve the GITLINK mode.
        const ctx = await buildSeededContext();
        const submoduleOid = 'cccccccccccccccccccccccccccccccccccccccc' as ObjectId;
        const treeId = await writeTree(ctx, [
          { name: 'submodule' as FilePath, id: submoduleOid, mode: FILE_MODE.GITLINK },
        ]);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.get('submodule' as FilePath)).toEqual({
          id: submoduleOid,
          mode: FILE_MODE.GITLINK,
        });
      });
    });
  });

  describe('Given two sibling directories that both point at the same subtree oid', () => {
    describe('When flattenTree runs', () => {
      it('Then both branches flatten fully (no false TREE_CYCLE_DETECTED)', async () => {
        // Arrange — x/ and y/ share the same subtree oid (containing f); the
        // per-branch descent stack must not treat the second visit as a cycle.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'shared');
        const sharedSubId = await writeTree(ctx, [
          { name: 'f' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'x' as FilePath, id: sharedSubId, mode: FILE_MODE.DIRECTORY },
          { name: 'y' as FilePath, id: sharedSubId, mode: FILE_MODE.DIRECTORY },
        ]);

        // Act
        const result = await flattenTree(ctx, rootId);

        // Assert
        expect(result.entries.get('x/f' as FilePath)?.id).toBe(blobId);
        expect(result.entries.get('y/f' as FilePath)?.id).toBe(blobId);
      });
    });
  });

  describe('Given a multi-depth tree with several blob entries', () => {
    describe('When flattenTree runs and a walkTree drain is compared over the same tree', () => {
      it('Then flattenTree yields the same entry set as the walkTree drain', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const idC = await writeBlob(ctx, 'C');
        const subId = await writeTree(ctx, [
          { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
          { name: 'c.txt' as FilePath, id: idC, mode: FILE_MODE.REGULAR },
          { name: 'sub' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
        ]);
        const walked = new Map<FilePath, FlatTreeEntry>();
        for await (const entry of walkTree(ctx, rootId)) {
          if (entry.mode === FILE_MODE.DIRECTORY) continue;
          walked.set(entry.path, { id: entry.id, mode: entry.mode });
        }

        // Act
        const result = await flattenTree(ctx, rootId);

        // Assert
        expect([...result.entries]).toEqual([...walked]);
      });

      it('Then flattenTree performs no more object reads than the equivalent walkTree drain', async () => {
        // Arrange — the bulk path must stay a zero-per-entry-promise route: it
        // builds the Map eagerly off walkTree's own object reads, with no
        // extra per-entry I/O of its own.
        const base = await buildSeededContext();
        const idA = await writeBlob(base, 'A');
        const idB = await writeBlob(base, 'B');
        const subId = await writeTree(base, [
          { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
        ]);
        const rootId = await writeTree(base, [
          { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
          { name: 'sub' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
        ]);
        const walkInstrument = instrumentedContext(base);
        for await (const _ of walkTree(walkInstrument.ctx, rootId)) {
          // drain
        }
        // F2.3 populates the shared delta cache on every loose read; clear it
        // so flattenTree's drain below pays the same cold-cache cost walkTree
        // just did, keeping this a fair, independent comparison.
        base.deltaCache.clear();
        const flattenInstrument = instrumentedContext(base);

        // Act
        await flattenTree(flattenInstrument.ctx, rootId);

        // Assert
        const readCount = (calls: ReturnType<typeof flattenInstrument.calls>): number =>
          calls.filter((call) => call.method === 'read').length;
        expect(readCount(flattenInstrument.calls())).toBe(readCount(walkInstrument.calls()));
      });
    });
  });

  describe('Given a non-tree oid root (a blob)', () => {
    describe('When flattenTree runs', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'not a tree');

        // Act + Assert
        try {
          await flattenTree(ctx, blobId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; expected: string; actual: string } };
          expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
          expect(data.expected).toBe('tree');
          expect(data.actual).toBe('blob');
        }
      });
    });
  });

  describe('Given a directory-mode entry whose oid resolves to a blob', () => {
    describe('When flattenTree runs', () => {
      it('Then the entry is skipped rather than thrown', async () => {
        // Arrange — a directory-mode entry pointing at a blob is silently
        // skipped (never recursed into, never throws), mirroring walkTree's
        // `if (subtreeObj.type === 'tree')` recursion guard.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'not a tree');
        const otherBlobId = await writeBlob(ctx, 'sibling');
        const treeId = await writeTree(ctx, [
          { name: 'd' as FilePath, id: blobId, mode: FILE_MODE.DIRECTORY },
          { name: 'sibling.txt' as FilePath, id: otherBlobId, mode: FILE_MODE.REGULAR },
        ]);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.size).toBe(1);
        expect(result.entries.get('sibling.txt' as FilePath)?.id).toBe(otherBlobId);
      });
    });
  });

  describe('Given a tree entry with an empty name', () => {
    describe('When flattenTree runs', () => {
      it('Then throws INVALID_TREE_ENTRY (structural: refused before any name-shape check)', async () => {
        // Arrange — the cursor's own structural scan refuses an empty name
        // (nameEnd === nameStart) before flattenTree's own name-shape check
        // ever observes it, so the reason is the cursor's, not
        // parseTreeContent's 'invalid entry name: ' shape message.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const content = rawEntry(FILE_MODE.REGULAR, '', blobId);
        const treeId = await writeRawObjectBytes(ctx, 'tree', content);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; offset: number; reason: string } };
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          expect(data.offset).toBe(0);
          expect(data.reason).toBe('empty filename');
        }
      });
    });
  });

  describe('Given a tree entry named "."', () => {
    describe('When flattenTree runs', () => {
      it('Then throws INVALID_TREE_ENTRY with the invalid-name reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const content = rawEntry(FILE_MODE.REGULAR, '.', blobId);
        const treeId = await writeRawObjectBytes(ctx, 'tree', content);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; offset: number; reason: string } };
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          expect(data.offset).toBe(0);
          expect(data.reason).toBe('invalid entry name: .');
        }
      });
    });
  });

  describe('Given a tree entry named ".."', () => {
    describe('When flattenTree runs', () => {
      it('Then throws INVALID_TREE_ENTRY with the invalid-name reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const content = rawEntry(FILE_MODE.REGULAR, '..', blobId);
        const treeId = await writeRawObjectBytes(ctx, 'tree', content);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; offset: number; reason: string } };
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          expect(data.offset).toBe(0);
          expect(data.reason).toBe('invalid entry name: ..');
        }
      });
    });
  });

  describe('Given a DIRECTORY-mode tree entry named ".."', () => {
    describe('When flattenTree runs', () => {
      it('Then throws INVALID_TREE_ENTRY with the invalid-name reason (name validation covers directories too)', async () => {
        // Arrange — validatedName runs unconditionally for every entry, before
        // the directory/non-directory branch, so a directory-mode entry with
        // an invalid name must refuse exactly like a blob-mode one.
        const ctx = await buildSeededContext();
        const subTreeId = await writeTree(ctx, []);
        const content = rawEntry(FILE_MODE.DIRECTORY, '..', subTreeId);
        const treeId = await writeRawObjectBytes(ctx, 'tree', content);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; offset: number; reason: string } };
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          expect(data.offset).toBe(0);
          expect(data.reason).toBe('invalid entry name: ..');
        }
      });
    });
  });

  describe('Given a tree entry named "a/b"', () => {
    describe('When flattenTree runs', () => {
      it('Then throws INVALID_TREE_ENTRY with the invalid-name reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const content = rawEntry(FILE_MODE.REGULAR, 'a/b', blobId);
        const treeId = await writeRawObjectBytes(ctx, 'tree', content);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; offset: number; reason: string } };
          expect(data.code).toBe('INVALID_TREE_ENTRY');
          expect(data.offset).toBe(0);
          expect(data.reason).toBe('invalid entry name: a/b');
        }
      });
    });
  });

  describe('Given a tree with two on-disk entries sharing the same name', () => {
    describe('When flattenTree runs', () => {
      it('Then the last entry on disk wins (duplicate detection moved to fsck)', async () => {
        // Arrange — `parseTreeContent` used to refuse this outright; the raw
        // descent drops the `Set<string>` duplicate check (fsck's job now),
        // so the Map resolves last-wins in on-disk order.
        const ctx = await buildSeededContext();
        const firstId = await writeBlob(ctx, 'first');
        const secondId = await writeBlob(ctx, 'second');
        const content = concatBytes(
          rawEntry(FILE_MODE.REGULAR, 'dup.txt', firstId),
          rawEntry(FILE_MODE.EXECUTABLE, 'dup.txt', secondId),
        );
        const treeId = await writeRawObjectBytes(ctx, 'tree', content);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.size).toBe(1);
        expect(result.entries.get('dup.txt' as FilePath)).toEqual({
          id: secondId,
          mode: FILE_MODE.EXECUTABLE,
        });
      });
    });
  });

  describe('Given an aborted signal before flattenTree starts', () => {
    describe('When flattenTree runs', () => {
      it('Then throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);
        const controller = new AbortController();
        controller.abort();
        const aborted = { ...ctx, signal: controller.signal };

        // Act + Assert
        try {
          await flattenTree(aborted, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string } };
          expect(data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });

  // --- core.maxTreeDepth boundary: the resolved cap, not a hardcoded value ---

  describe('Given a repository configured with core.maxTreeDepth = 4', () => {
    describe('When flattenTree is driven at depth 4', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const treeId = await buildDirectoryChain(ctx, 4);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.size).toBe(1);
      });
    });

    describe('When flattenTree is driven at depth 5', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 5', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const treeId = await buildDirectoryChain(ctx, 5);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(5);
        }
      });
    });
  });

  describe('Given a repository configured with core.maxTreeDepth = 4 and a tree 20x past the cap', () => {
    describe('When flattenTree runs', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 5, not the deeper structural depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const treeId = await buildDirectoryChain(ctx, 80);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(5);
        }
      });
    });
  });

  describe('Given the same depth-4 tree tested at two different core.maxTreeDepth values', () => {
    describe('When core.maxTreeDepth = 4', () => {
      it('Then it completes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '4');
        const treeId = await buildDirectoryChain(ctx, 4);

        // Act
        const result = await flattenTree(ctx, treeId);

        // Assert
        expect(result.entries.size).toBe(1);
      });
    });

    describe('When core.maxTreeDepth = 3', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with depth === 4', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '3');
        const treeId = await buildDirectoryChain(ctx, 4);

        // Act + Assert
        try {
          await flattenTree(ctx, treeId);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(4);
        }
      });
    });
  });
});

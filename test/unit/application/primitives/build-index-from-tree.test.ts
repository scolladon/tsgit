import { describe, expect, it } from 'vitest';

import { buildIndexFromTree } from '../../../../src/application/primitives/build-index-from-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const EMPTY_INDEX: GitIndex = { version: 2, entries: [], extensions: [] };

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const makeIndexEntry = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
  stats: Partial<Omit<IndexEntry, 'path' | 'id' | 'mode' | 'flags'>> = {},
  stage: 0 | 1 | 2 | 3 = 0,
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
  ...stats,
});

describe('buildIndexFromTree', () => {
  describe('Given an empty tree', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then returns empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const emptyTree = await writeTree(ctx, []);
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, { targetTree: emptyTree, currentIndex: EMPTY_INDEX });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a tree with one blob and no donor', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then emits one entry with zero stat fields', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const treeEntries: TreeEntry[] = [
          { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ];
        const treeId = await writeTree(ctx, treeEntries);
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });

        // Assert
        expect(result).toHaveLength(1);
        const entry = result[0];
        expect(entry?.path).toBe('a.txt');
        expect(entry?.id).toBe(blobId);
        expect(entry?.mode).toBe(FILE_MODE.REGULAR);
        expect(entry?.ctimeSeconds).toBe(0);
        expect(entry?.ctimeNanoseconds).toBe(0);
        expect(entry?.mtimeSeconds).toBe(0);
        expect(entry?.mtimeNanoseconds).toBe(0);
        expect(entry?.dev).toBe(0);
        expect(entry?.ino).toBe(0);
        expect(entry?.uid).toBe(0);
        expect(entry?.gid).toBe(0);
        expect(entry?.fileSize).toBe(0);
        expect(entry?.flags).toEqual(STAGE0_FLAGS);
      });
    });
  });

  describe('Given a matching donor entry (same path + id + mode)', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then preserves donor stat-cache fields', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const treeEntries: TreeEntry[] = [
          { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ];
        const treeId = await writeTree(ctx, treeEntries);
        const donor: IndexEntry = {
          ...makeIndexEntry('a.txt', blobId, FILE_MODE.REGULAR, {
            ctimeSeconds: 1_700_000_000,
            ctimeNanoseconds: 123_456_789,
            mtimeSeconds: 1_700_000_100,
            mtimeNanoseconds: 987_654_321,
            dev: 42,
            ino: 99,
            uid: 1000,
            gid: 1000,
            fileSize: 5,
          }),
          flags: { ...STAGE0_FLAGS, assumeValid: true, skipWorktree: true },
        };
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: { ...EMPTY_INDEX, entries: [donor] },
        });

        // Assert — stat cache cloned byte-for-byte AND flags spread preserves donor's
        // assumeValid/skipWorktree (stage is force-set to 0 regardless).
        expect(result).toHaveLength(1);
        const entry = result[0];
        expect(entry?.ctimeSeconds).toBe(1_700_000_000);
        expect(entry?.ctimeNanoseconds).toBe(123_456_789);
        expect(entry?.mtimeSeconds).toBe(1_700_000_100);
        expect(entry?.mtimeNanoseconds).toBe(987_654_321);
        expect(entry?.dev).toBe(42);
        expect(entry?.ino).toBe(99);
        expect(entry?.uid).toBe(1000);
        expect(entry?.gid).toBe(1000);
        expect(entry?.fileSize).toBe(5);
        expect(entry?.flags.assumeValid).toBe(true);
        expect(entry?.flags.skipWorktree).toBe(true);
        expect(entry?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given both stage-0 and stage-1 donors for the same path', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then the stage-0 entry wins', async () => {
        // Arrange — post-merge index can carry both an unmerged entry (stage 1/2/3)
        // and a stage-0 entry at the same path. Only the stage-0 entry's stat cache
        // should donate; the stage-N entry must never become a stat-cache donor.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);
        const unmerged = makeIndexEntry(
          'a.txt',
          blobId,
          FILE_MODE.REGULAR,
          { mtimeSeconds: 999 },
          1,
        );
        const stageZero = makeIndexEntry('a.txt', blobId, FILE_MODE.REGULAR, { mtimeSeconds: 42 });
        const sut = buildIndexFromTree;

        // Act — order the entries so the stage-1 entry is iterated last; a mutant
        // that drops the `stage !== 0` guard would let it overwrite the stage-0
        // donor in the map and we would see mtime=999 instead of 42.
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: { ...EMPTY_INDEX, entries: [stageZero, unmerged] },
        });

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.mtimeSeconds).toBe(42);
      });
    });
  });

  describe('Given a donor with same id but different mode', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then no donor match (zero stats)', async () => {
        // Arrange — donor is regular, target tree promotes to executable
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, '#!/bin/sh');
        const treeId = await writeTree(ctx, [
          { name: 'run.sh' as FilePath, id: blobId, mode: FILE_MODE.EXECUTABLE },
        ]);
        const donor = makeIndexEntry('run.sh', blobId, FILE_MODE.REGULAR, {
          mtimeSeconds: 1_700_000_000,
          fileSize: 9,
        });
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: { ...EMPTY_INDEX, entries: [donor] },
        });

        // Assert — mode mismatch invalidates donor; entry has zero stats and the target mode
        expect(result).toHaveLength(1);
        const entry = result[0];
        expect(entry?.mode).toBe(FILE_MODE.EXECUTABLE);
        expect(entry?.mtimeSeconds).toBe(0);
        expect(entry?.fileSize).toBe(0);
      });
    });
  });

  describe('Given a donor with same mode but different id', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then no donor match (zero stats)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldBlob = await writeBlob(ctx, 'old');
        const newBlob = await writeBlob(ctx, 'new');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: newBlob, mode: FILE_MODE.REGULAR },
        ]);
        const donor = makeIndexEntry('a.txt', oldBlob, FILE_MODE.REGULAR, {
          mtimeSeconds: 1_700_000_000,
          fileSize: 3,
        });
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: { ...EMPTY_INDEX, entries: [donor] },
        });

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe(newBlob);
        expect(result[0]?.mtimeSeconds).toBe(0);
        expect(result[0]?.fileSize).toBe(0);
      });
    });
  });

  describe('Given a stage-2 donor (unmerged)', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then ignores donor (zero stats)', async () => {
        // Arrange — unmerged donor must never contribute stat cache
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const treeId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
        ]);
        const donor = makeIndexEntry(
          'a.txt',
          blobId,
          FILE_MODE.REGULAR,
          { mtimeSeconds: 1_700_000_000, fileSize: 5 },
          2,
        );
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: { ...EMPTY_INDEX, entries: [donor] },
        });

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.mtimeSeconds).toBe(0);
        expect(result[0]?.fileSize).toBe(0);
        expect(result[0]?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given a donor for a path absent from the target tree', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then donor is dropped', async () => {
        // Arrange — index has 'gone.txt'; target tree has only 'keep.txt'
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, 'keep');
        const treeId = await writeTree(ctx, [
          { name: 'keep.txt' as FilePath, id: blob, mode: FILE_MODE.REGULAR },
        ]);
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: {
            ...EMPTY_INDEX,
            entries: [makeIndexEntry('gone.txt', blob), makeIndexEntry('keep.txt', blob)],
          },
        });

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.path).toBe('keep.txt');
      });
    });
  });

  describe('Given a nested tree', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then flattens to leaf paths with no DIRECTORY rows', async () => {
        // Arrange — root tree has one file plus one subtree containing a file
        const ctx = await buildSeededContext();
        const leafBlob = await writeBlob(ctx, 'deep');
        const rootBlob = await writeBlob(ctx, 'top');
        const subTreeId = await writeTree(ctx, [
          { name: 'inner.txt' as FilePath, id: leafBlob, mode: FILE_MODE.REGULAR },
        ]);
        const rootTreeId = await writeTree(ctx, [
          { name: 'sub' as FilePath, id: subTreeId, mode: FILE_MODE.DIRECTORY },
          { name: 'top.txt' as FilePath, id: rootBlob, mode: FILE_MODE.REGULAR },
        ]);
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, { targetTree: rootTreeId, currentIndex: EMPTY_INDEX });

        // Assert — both leaf paths, sorted; no 'sub' entry (DIRECTORY filtered out)
        expect(result.map((e) => e.path)).toEqual(['sub/inner.txt', 'top.txt']);
        expect(result.every((e) => e.mode !== FILE_MODE.DIRECTORY)).toBe(true);
      });
    });
  });

  describe('Given a flat tree', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then the returned entries are byte-sorted by path', async () => {
        // Arrange — `writeTree` routes through `serializeTreeContent` →
        // `sortTreeEntries`, so the wire bytes are always canonically ordered.
        // This test asserts the OUTPUT invariant (byte-sorted index entries)
        // rather than the SORT invocation — the defensive sort in the primitive
        // exists precisely to keep the output invariant if a future caller
        // bypasses the canonical writers.
        const ctx = await buildSeededContext();
        const blobA = await writeBlob(ctx, 'A');
        const blobB = await writeBlob(ctx, 'B');
        const blobC = await writeBlob(ctx, 'C');
        const treeId = await writeTree(ctx, [
          { name: 'b.txt' as FilePath, id: blobB, mode: FILE_MODE.REGULAR },
          { name: 'a.txt' as FilePath, id: blobA, mode: FILE_MODE.REGULAR },
          { name: 'c.txt' as FilePath, id: blobC, mode: FILE_MODE.REGULAR },
        ]);
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });

        // Assert
        expect(result.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      });
    });
  });

  describe('with a sparse matcher', () => {
    // Excludes any path starting with `drop`; includes everything else.
    const excludesDrop = (p: FilePath): boolean => !p.startsWith('drop');

    describe('Given a sparse matcher excluding a path with a matching donor', () => {
      describe('When buildIndexFromTree runs', () => {
        it('Then the entry is skip-worktree with zeroed stats', async () => {
          // Arrange — the donor carries real stat cache, but the matcher excludes
          // the path; the matcher is authoritative over the donor's bits.
          const ctx = await buildSeededContext();
          const blobId = await writeBlob(ctx, 'hello');
          const treeId = await writeTree(ctx, [
            { name: 'drop.js' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
          ]);
          const donor = makeIndexEntry('drop.js', blobId, FILE_MODE.REGULAR, {
            mtimeSeconds: 1_700_000_000,
            fileSize: 5,
          });
          const sut = buildIndexFromTree;

          // Act
          const result = await sut(ctx, {
            targetTree: treeId,
            currentIndex: { ...EMPTY_INDEX, entries: [donor] },
            sparse: excludesDrop,
          });

          // Assert — donor stats discarded, skip-worktree set, id/mode kept.
          expect(result).toHaveLength(1);
          const entry = result[0];
          expect(entry?.flags.skipWorktree).toBe(true);
          expect(entry?.flags.stage).toBe(0);
          expect(entry?.mtimeSeconds).toBe(0);
          expect(entry?.fileSize).toBe(0);
          expect(entry?.id).toBe(blobId);
          expect(entry?.mode).toBe(FILE_MODE.REGULAR);
        });
      });
    });

    describe('Given a sparse matcher excluding a path with no donor', () => {
      describe('When buildIndexFromTree runs', () => {
        it('Then the entry is a zero-stat skip-worktree entry', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const blobId = await writeBlob(ctx, 'hello');
          const treeId = await writeTree(ctx, [
            { name: 'drop.js' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
          ]);
          const sut = buildIndexFromTree;

          // Act
          const result = await sut(ctx, {
            targetTree: treeId,
            currentIndex: EMPTY_INDEX,
            sparse: excludesDrop,
          });

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.flags.skipWorktree).toBe(true);
          expect(result[0]?.mtimeSeconds).toBe(0);
        });
      });
    });

    describe('Given a sparse matcher including a path whose donor carries a stale skip-worktree bit', () => {
      describe('When buildIndexFromTree runs', () => {
        it('Then the rebuilt entry clears skip-worktree but keeps donor stats', async () => {
          // Arrange — the path was excluded before (donor skip-worktree) but the
          // current matcher includes it; the matcher wins, the bit is cleared.
          const ctx = await buildSeededContext();
          const blobId = await writeBlob(ctx, 'hello');
          const treeId = await writeTree(ctx, [
            { name: 'keep.js' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
          ]);
          const donor: IndexEntry = {
            ...makeIndexEntry('keep.js', blobId, FILE_MODE.REGULAR, {
              mtimeSeconds: 1_700_000_000,
              fileSize: 5,
            }),
            flags: { ...STAGE0_FLAGS, skipWorktree: true },
          };
          const sut = buildIndexFromTree;

          // Act
          const result = await sut(ctx, {
            targetTree: treeId,
            currentIndex: { ...EMPTY_INDEX, entries: [donor] },
            sparse: excludesDrop,
          });

          // Assert — skip-worktree cleared, donor stat cache preserved.
          expect(result).toHaveLength(1);
          expect(result[0]?.flags.skipWorktree).toBe(false);
          expect(result[0]?.flags.stage).toBe(0);
          expect(result[0]?.mtimeSeconds).toBe(1_700_000_000);
          expect(result[0]?.fileSize).toBe(5);
        });
      });
    });

    describe('Given a sparse matcher including a path with a matching donor', () => {
      describe('When buildIndexFromTree runs', () => {
        it('Then donor stats are preserved and skip-worktree is clear', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const blobId = await writeBlob(ctx, 'hello');
          const treeId = await writeTree(ctx, [
            { name: 'keep.js' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
          ]);
          const donor = makeIndexEntry('keep.js', blobId, FILE_MODE.REGULAR, {
            mtimeSeconds: 1_700_000_000,
            fileSize: 5,
          });
          const sut = buildIndexFromTree;

          // Act
          const result = await sut(ctx, {
            targetTree: treeId,
            currentIndex: { ...EMPTY_INDEX, entries: [donor] },
            sparse: excludesDrop,
          });

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.flags.skipWorktree).toBe(false);
          expect(result[0]?.mtimeSeconds).toBe(1_700_000_000);
          expect(result[0]?.fileSize).toBe(5);
        });
      });
    });

    describe('Given a sparse matcher including a path with no donor', () => {
      describe('When buildIndexFromTree runs', () => {
        it('Then the entry has zero stats and a clear skip-worktree bit', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const blobId = await writeBlob(ctx, 'hello');
          const treeId = await writeTree(ctx, [
            { name: 'keep.js' as FilePath, id: blobId, mode: FILE_MODE.REGULAR },
          ]);
          const sut = buildIndexFromTree;

          // Act
          const result = await sut(ctx, {
            targetTree: treeId,
            currentIndex: EMPTY_INDEX,
            sparse: excludesDrop,
          });

          // Assert
          expect(result).toHaveLength(1);
          expect(result[0]?.flags.skipWorktree).toBe(false);
          expect(result[0]?.mtimeSeconds).toBe(0);
        });
      });
    });

    describe('Given a sparse matcher partitioning a tree', () => {
      describe('When buildIndexFromTree runs', () => {
        it('Then in-pattern and excluded paths get the right skip-worktree bits', async () => {
          // Arrange — one tree, two leaves, one matcher call per leaf.
          const ctx = await buildSeededContext();
          const keepBlob = await writeBlob(ctx, 'keep');
          const dropBlob = await writeBlob(ctx, 'drop');
          const treeId = await writeTree(ctx, [
            { name: 'drop.js' as FilePath, id: dropBlob, mode: FILE_MODE.REGULAR },
            { name: 'keep.js' as FilePath, id: keepBlob, mode: FILE_MODE.REGULAR },
          ]);
          const sut = buildIndexFromTree;

          // Act
          const result = await sut(ctx, {
            targetTree: treeId,
            currentIndex: EMPTY_INDEX,
            sparse: excludesDrop,
          });

          // Assert
          expect(result.find((e) => e.path === 'drop.js')?.flags.skipWorktree).toBe(true);
          expect(result.find((e) => e.path === 'keep.js')?.flags.skipWorktree).toBe(false);
        });
      });
    });
  });

  describe('Given symlink and gitlink tree entries', () => {
    describe('When buildIndexFromTree runs', () => {
      it('Then preserves their modes in the index', async () => {
        // Arrange — gitlink id is the submodule commit oid; symlink id is the symlink-target blob
        const ctx = await buildSeededContext();
        const linkBlob = await writeBlob(ctx, 'target/path');
        const submoduleOid = 'cccccccccccccccccccccccccccccccccccccccc' as ObjectId;
        const treeId = await writeTree(ctx, [
          { name: 'link' as FilePath, id: linkBlob, mode: FILE_MODE.SYMLINK },
          { name: 'sub' as FilePath, id: submoduleOid, mode: FILE_MODE.GITLINK },
        ]);
        const sut = buildIndexFromTree;

        // Act
        const result = await sut(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });

        // Assert
        expect(result).toHaveLength(2);
        const link = result.find((e) => e.path === 'link');
        const sub = result.find((e) => e.path === 'sub');
        expect(link?.mode).toBe(FILE_MODE.SYMLINK);
        expect(link?.id).toBe(linkBlob);
        expect(sub?.mode).toBe(FILE_MODE.GITLINK);
        expect(sub?.id).toBe(submoduleOid);
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from '../../../../src/domain/diff/flat-tree.js';
import {
  conflictsToIndexEntries,
  diffIndexAgainstTree,
  groupUnmergedEntries,
  sortedRecordedPaths,
} from '../../../../src/domain/diff/index-diff.js';
import type {
  GitIndex,
  IndexEntry,
  IndexEntryFlags,
  StatData,
} from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import type { MergeConflict } from '../../../../src/domain/merge/merge-types.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;
const ID_C = 'c'.repeat(40) as ObjectId;
const ID_D = 'd'.repeat(40) as ObjectId;

function zeroStat(mode: FileMode): StatData {
  return {
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
  };
}

function flags(stage: 0 | 1 | 2 | 3): IndexEntryFlags {
  return { ...STAGE0_FLAGS, stage };
}

function entry(path: string, id: ObjectId, mode: FileMode, stage: 0 | 1 | 2 | 3): IndexEntry {
  return {
    ...zeroStat(mode),
    id,
    flags: flags(stage),
    path: path as FilePath,
  };
}

function index(entries: ReadonlyArray<IndexEntry>): GitIndex {
  return { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) };
}

function flatTree(pairs: ReadonlyArray<readonly [string, ObjectId, FileMode]>): FlatTree {
  const map = new Map<FilePath, FlatTreeEntry>();
  for (const [path, id, mode] of pairs) {
    map.set(path as FilePath, { id, mode });
  }
  return { entries: map };
}

describe('diffIndexAgainstTree', () => {
  describe('Given empty index + empty tree', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then empty TreeDiff', () => {
        // Arrange & Act
        const sut = diffIndexAgainstTree(index([]), undefined);

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given only stage-0 entries matching tree exactly', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then empty TreeDiff', () => {
        // Arrange & Act
        const sut = diffIndexAgainstTree(
          index([entry('foo', ID_A, FILE_MODE.REGULAR, 0)]),
          flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
        );

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given index with stage 1/2/3 unmerged entries', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then those entries skipped', () => {
        // Arrange & Act — index has stages 1, 2, 3 for 'conflict'; nothing at stage 0 matches 'conflict' path
        const sut = diffIndexAgainstTree(
          index([
            entry('conflict', ID_A, FILE_MODE.REGULAR, 1),
            entry('conflict', ID_B, FILE_MODE.REGULAR, 2),
            entry('conflict', ID_C, FILE_MODE.REGULAR, 3),
          ]),
          flatTree([['conflict', ID_A, FILE_MODE.REGULAR]]),
        );

        // Assert — since no stage-0 entry for 'conflict', tree entry yields a delete
        expect(sut.changes).toEqual([
          {
            type: 'delete',
            oldPath: 'conflict',
            oldId: ID_A,
            oldMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given path in tree but not index', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then DeleteChange emitted', () => {
        // Arrange & Act
        const sut = diffIndexAgainstTree(index([]), flatTree([['gone', ID_A, FILE_MODE.REGULAR]]));

        // Assert
        expect(sut.changes).toEqual([
          { type: 'delete', oldPath: 'gone', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given path in index but not tree', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then AddChange emitted', () => {
        // Arrange & Act
        const sut = diffIndexAgainstTree(
          index([entry('new', ID_A, FILE_MODE.REGULAR, 0)]),
          undefined,
        );

        // Assert
        expect(sut.changes).toEqual([
          { type: 'add', newPath: 'new', newId: ID_A, newMode: FILE_MODE.REGULAR },
        ]);
      });
    });
  });

  describe('Given same path with different id (same kind)', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then ModifyChange', () => {
        // Arrange & Act
        const sut = diffIndexAgainstTree(
          index([entry('foo', ID_B, FILE_MODE.REGULAR, 0)]),
          flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
        );

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'foo',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        ]);
      });
    });
  });

  describe('Given same path with different kind', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then TypeChangeChange', () => {
        // Arrange & Act — file -> symlink
        const sut = diffIndexAgainstTree(
          index([entry('foo', ID_B, FILE_MODE.SYMLINK, 0)]),
          flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
        );

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'type-change',
            path: 'foo',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        ]);
      });
    });
  });

  describe('Given same id but a DIFFERENT mode (same kind)', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then ModifyChange (the mode-equality guard is not skipped)', () => {
        // Arrange & Act — identical id, REGULAR -> EXECUTABLE: ids match so a
        // `true`-mutated mode guard would treat it as unchanged and emit nothing.
        const sut = diffIndexAgainstTree(
          index([entry('foo', ID_A, FILE_MODE.EXECUTABLE, 0)]),
          flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
        );

        // Assert — a change MUST be emitted because the mode differs.
        expect(sut.changes).toEqual([
          {
            type: 'modify',
            path: 'foo',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
          },
        ]);
      });
    });
  });

  describe('Given same id but a DIFFERENT kind of mode', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then TypeChangeChange (mode guard still evaluated when ids match)', () => {
        // Arrange & Act — identical id, REGULAR -> SYMLINK.
        const sut = diffIndexAgainstTree(
          index([entry('foo', ID_A, FILE_MODE.SYMLINK, 0)]),
          flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
        );

        // Assert
        expect(sut.changes).toEqual([
          {
            type: 'type-change',
            path: 'foo',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        ]);
      });
    });
  });

  describe('Given FlatTree with MAX_FLAT_TREE_ENTRIES + 1 entries', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then throws INVALID_TREE_FOR_DIFF', () => {
        // Arrange — simulate an oversize FlatTree using a map-like object; avoid building a million entries
        const oversizeEntries = {
          get: () => undefined,
          keys: () => [][Symbol.iterator](),
          size: MAX_FLAT_TREE_ENTRIES + 1,
        } as unknown as ReadonlyMap<FilePath, FlatTreeEntry>;
        const oversize: FlatTree = { entries: oversizeEntries };

        // Act
        let thrown: unknown;
        try {
          diffIndexAgainstTree(index([]), oversize);
        } catch (e) {
          thrown = e;
        }

        // Assert
        expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
          'INVALID_TREE_FOR_DIFF',
        );
        expect((thrown as { data: { reason: string } }).data.reason).toContain(
          'MAX_FLAT_TREE_ENTRIES',
        );
      });
    });
  });

  describe('Given FlatTree with exactly MAX_FLAT_TREE_ENTRIES entries', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then succeeds without throwing', () => {
        // Arrange — simulate a FlatTree at exactly the cap; cap check uses >, so size === cap should pass
        const atCapEntries = {
          get: () => undefined,
          keys: () => [][Symbol.iterator](),
          size: MAX_FLAT_TREE_ENTRIES,
        } as unknown as ReadonlyMap<FilePath, FlatTreeEntry>;
        const atCap: FlatTree = { entries: atCapEntries };

        // Act
        const sut = diffIndexAgainstTree(index([]), atCap);

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given mixed case output', () => {
    describe('When diffIndexAgainstTree called', () => {
      it('Then changes sorted byte-order on primary path key', () => {
        // Arrange & Act
        const sut = diffIndexAgainstTree(
          index([entry('b', ID_B, FILE_MODE.REGULAR, 0), entry('d', ID_B, FILE_MODE.REGULAR, 0)]),
          flatTree([
            ['a', ID_A, FILE_MODE.REGULAR],
            ['c', ID_C, FILE_MODE.REGULAR],
          ]),
        );

        // Assert — sorted: delete 'a', add 'b', delete 'c', add 'd'
        const keys = sut.changes.map((c) => {
          if (c.type === 'add') return c.newPath;
          if (c.type === 'delete') return c.oldPath;
          if (c.type === 'rename') return c.newPath;
          return c.path;
        });
        expect(keys).toEqual(['a', 'b', 'c', 'd']);
      });
    });
  });
});

describe('groupUnmergedEntries', () => {
  describe('Given index with only stage-0 entries', () => {
    describe('When groupUnmergedEntries called', () => {
      it('Then staged populated and unmerged empty', () => {
        // Arrange & Act
        const sut = groupUnmergedEntries(index([entry('foo', ID_A, FILE_MODE.REGULAR, 0)]));

        // Assert
        expect(sut.staged).toHaveLength(1);
        expect(sut.unmerged.size).toBe(0);
      });
    });
  });

  describe('Given index with stages 1, 2, 3 for one path', () => {
    describe('When groupUnmergedEntries called', () => {
      it('Then unmerged entry contains all three', () => {
        // Arrange & Act
        const sut = groupUnmergedEntries(
          index([
            entry('conflict', ID_A, FILE_MODE.REGULAR, 1),
            entry('conflict', ID_B, FILE_MODE.REGULAR, 2),
            entry('conflict', ID_C, FILE_MODE.REGULAR, 3),
          ]),
        );

        // Assert
        const group = sut.unmerged.get('conflict' as FilePath);
        expect(group).toBeDefined();
        expect(group?.stage1?.id).toBe(ID_A);
        expect(group?.stage2?.id).toBe(ID_B);
        expect(group?.stage3?.id).toBe(ID_C);
      });
    });
  });

  describe('Given index with only stage 2 for a path', () => {
    describe('When groupUnmergedEntries called', () => {
      it('Then unmerged entry has stage2 only; no throw (forgiving)', () => {
        // Arrange & Act
        const sut = groupUnmergedEntries(index([entry('c', ID_B, FILE_MODE.REGULAR, 2)]));

        // Assert
        const group = sut.unmerged.get('c' as FilePath);
        expect(group?.stage1).toBeUndefined();
        expect(group?.stage2?.id).toBe(ID_B);
        expect(group?.stage3).toBeUndefined();
      });
    });
  });

  describe('Given index with only stage 1 for a path', () => {
    describe('When groupUnmergedEntries called', () => {
      it('Then unmerged entry has stage1 only; no throw', () => {
        // Arrange & Act
        const sut = groupUnmergedEntries(index([entry('c', ID_A, FILE_MODE.REGULAR, 1)]));

        // Assert
        const group = sut.unmerged.get('c' as FilePath);
        expect(group?.stage1?.id).toBe(ID_A);
        expect(group?.stage2).toBeUndefined();
        expect(group?.stage3).toBeUndefined();
      });
    });
  });

  describe('Given index with stages 1 + 3 only (no stage 2)', () => {
    describe('When groupUnmergedEntries called', () => {
      it('Then stage2 absent', () => {
        // Arrange & Act
        const sut = groupUnmergedEntries(
          index([entry('c', ID_A, FILE_MODE.REGULAR, 1), entry('c', ID_C, FILE_MODE.REGULAR, 3)]),
        );

        // Assert
        const group = sut.unmerged.get('c' as FilePath);
        expect(group?.stage1?.id).toBe(ID_A);
        expect(group?.stage2).toBeUndefined();
        expect(group?.stage3?.id).toBe(ID_C);
      });
    });
  });
});

describe('conflictsToIndexEntries', () => {
  function conflict(partial: Partial<MergeConflict> & { path: FilePath }): MergeConflict {
    return {
      type: 'content',
      ...partial,
    } as MergeConflict;
  }

  describe('Given one conflict with baseId/ourId/theirId all set', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then 3 entries emitted in (path, stage) byte-order', () => {
        // Arrange
        const sut = conflictsToIndexEntries(
          [
            conflict({
              path: 'file' as FilePath,
              baseId: ID_A,
              ourId: ID_B,
              theirId: ID_C,
              baseMode: FILE_MODE.REGULAR,
              ourMode: FILE_MODE.REGULAR,
              theirMode: FILE_MODE.REGULAR,
            }),
          ],
          zeroStat,
        );

        // Assert
        expect(sut).toHaveLength(3);
        expect(sut[0]?.flags.stage).toBe(1);
        expect(sut[0]?.id).toBe(ID_A);
        expect(sut[1]?.flags.stage).toBe(2);
        expect(sut[1]?.id).toBe(ID_B);
        expect(sut[2]?.flags.stage).toBe(3);
        expect(sut[2]?.id).toBe(ID_C);
      });
    });
  });

  describe('Given one conflict with only ourId set', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then the emitted entry flags are assumeValid=false and skipWorktree=false', () => {
        // Arrange & Act — index entries built for conflicts must NOT carry the
        // assume-valid or skip-worktree/intent-to-add bits; all default to false.
        const sut = conflictsToIndexEntries(
          [conflict({ path: 'file' as FilePath, ourId: ID_B, ourMode: FILE_MODE.REGULAR })],
          zeroStat,
        );

        // Assert
        expect(sut[0]?.flags.assumeValid).toBe(false);
        expect(sut[0]?.flags.skipWorktree).toBe(false);
        expect(sut[0]?.flags.intentToAdd).toBe(false);
      });
      it('Then 1 entry at stage 2', () => {
        // Arrange
        const sut = conflictsToIndexEntries(
          [
            conflict({
              path: 'file' as FilePath,
              ourId: ID_B,
              ourMode: FILE_MODE.REGULAR,
            }),
          ],
          zeroStat,
        );

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut[0]?.flags.stage).toBe(2);
        expect(sut[0]?.id).toBe(ID_B);
      });
    });
  });

  describe('Given one conflict with no ids set', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then 0 entries emitted', () => {
        // Arrange
        const sut = conflictsToIndexEntries([conflict({ path: 'file' as FilePath })], zeroStat);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given two conflicts sharing same path', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({ path: 'same' as FilePath, ourId: ID_A, ourMode: FILE_MODE.REGULAR }),
          conflict({ path: 'same' as FilePath, ourId: ID_B, ourMode: FILE_MODE.REGULAR }),
        ];

        // Act
        let thrown: unknown;
        try {
          conflictsToIndexEntries(conflicts, zeroStat);
        } catch (e) {
          thrown = e;
        }

        // Assert
        expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
          'INVALID_DIFF_INPUT',
        );
        expect((thrown as { data: { reason: string } }).data.reason).toContain('duplicate');
      });
    });
  });

  describe('Given conflict with distinct baseMode / ourMode / theirMode', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then statFactory invoked per stage with its mode', () => {
        // Arrange
        const observed: FileMode[] = [];
        const spy: (mode: FileMode) => StatData = (mode) => {
          observed.push(mode);
          return zeroStat(mode);
        };

        // Act
        const sut = conflictsToIndexEntries(
          [
            conflict({
              path: 'file' as FilePath,
              baseId: ID_A,
              ourId: ID_B,
              theirId: ID_C,
              baseMode: FILE_MODE.REGULAR,
              ourMode: FILE_MODE.EXECUTABLE,
              theirMode: FILE_MODE.SYMLINK,
            }),
          ],
          spy,
        );

        // Assert
        expect(observed).toEqual([FILE_MODE.REGULAR, FILE_MODE.EXECUTABLE, FILE_MODE.SYMLINK]);
        expect(sut.map((e) => e.mode)).toEqual([
          FILE_MODE.REGULAR,
          FILE_MODE.EXECUTABLE,
          FILE_MODE.SYMLINK,
        ]);
      });
    });
  });

  describe('Given multiple conflicts', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then entries sorted by (path, stage) byte-order', () => {
        // Arrange
        const sut = conflictsToIndexEntries(
          [
            conflict({
              path: 'b' as FilePath,
              ourId: ID_B,
              ourMode: FILE_MODE.REGULAR,
            }),
            conflict({
              path: 'a' as FilePath,
              baseId: ID_A,
              ourId: ID_B,
              theirId: ID_C,
              baseMode: FILE_MODE.REGULAR,
              ourMode: FILE_MODE.REGULAR,
              theirMode: FILE_MODE.REGULAR,
            }),
          ],
          zeroStat,
        );

        // Assert
        const keys = sut.map((e) => `${e.path}:${e.flags.stage}`);
        expect(keys).toEqual(['a:1', 'a:2', 'a:3', 'b:2']);
      });
    });
  });

  describe('Given a distinct-types conflict (path f, ourPath f~HEAD, theirPath f)', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then emits stage 2 at ourPath and stage 3 at theirPath, no stage 1, path-sorted', () => {
        // Arrange
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'f' as FilePath,
              ourPath: 'f~HEAD' as FilePath,
              theirPath: 'f' as FilePath,
              ourId: ID_B,
              ourMode: FILE_MODE.EXECUTABLE,
              theirId: ID_C,
              theirMode: FILE_MODE.SYMLINK,
            }),
          ],
          zeroStat,
        );

        // Assert — exactly two entries; f (stage 3) sorts before f~HEAD (stage 2)
        expect(sut).toHaveLength(2);
        expect(sut[0]?.path).toBe('f');
        expect(sut[0]?.flags.stage).toBe(3);
        expect(sut[0]?.id).toBe(ID_C);
        expect(sut[0]?.mode).toBe(FILE_MODE.SYMLINK);
        expect(sut[1]?.path).toBe('f~HEAD');
        expect(sut[1]?.flags.stage).toBe(2);
        expect(sut[1]?.id).toBe(ID_B);
        expect(sut[1]?.mode).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });

  describe('Given two conflicts whose recorded paths collide (distinct-types ourPath matches another conflict path)', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then throws INVALID_DIFF_INPUT on recorded-path collision', () => {
        // Arrange — distinct-types conflict with ourPath 'g~HEAD'; a regular
        // conflict at 'g~HEAD' collides on the recorded path
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({
            type: 'distinct-types',
            path: 'g' as FilePath,
            ourPath: 'g~HEAD' as FilePath,
            theirPath: 'g' as FilePath,
            ourId: ID_A,
            ourMode: FILE_MODE.REGULAR,
            theirId: ID_B,
            theirMode: FILE_MODE.SYMLINK,
          }),
          conflict({
            path: 'g~HEAD' as FilePath,
            ourId: ID_C,
            ourMode: FILE_MODE.REGULAR,
          }),
        ];

        // Act
        let thrown: unknown;
        try {
          conflictsToIndexEntries(conflicts, zeroStat);
        } catch (e) {
          thrown = e;
        }

        // Assert
        expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
          'INVALID_DIFF_INPUT',
        );
        expect((thrown as { data: { reason: string } }).data.reason).toContain('duplicate');
      });
    });
  });

  describe('Given a distinct-types conflict alongside an unrelated conflict at a different path', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then does not throw and emits all entries', () => {
        // Arrange — distinct-types at 'h' (ourPath h~HEAD, theirPath h) plus a
        // regular conflict at 'z'; no recorded-path overlap
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'h' as FilePath,
              ourPath: 'h~HEAD' as FilePath,
              theirPath: 'h' as FilePath,
              ourId: ID_A,
              ourMode: FILE_MODE.REGULAR,
              theirId: ID_B,
              theirMode: FILE_MODE.SYMLINK,
            }),
            conflict({
              path: 'z' as FilePath,
              ourId: ID_C,
              ourMode: FILE_MODE.REGULAR,
            }),
          ],
          zeroStat,
        );

        // Assert — 3 entries total (2 for distinct-types + 1 for regular), no throw
        expect(sut).toHaveLength(3);
        const keys = sut.map((e) => `${e.path}:${e.flags.stage}`);
        expect(keys).toEqual(['h:3', 'h~HEAD:2', 'z:2']);
      });
    });
  });

  describe('Given a distinct-types conflict with no ourId set', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then emits only stage 3 entry at theirPath', () => {
        // Arrange — partial distinct-types: ourId absent, only theirs present
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'k' as FilePath,
              ourPath: 'k~HEAD' as FilePath,
              theirPath: 'k' as FilePath,
              theirId: ID_C,
              theirMode: FILE_MODE.SYMLINK,
            }),
          ],
          zeroStat,
        );

        // Assert — only theirs entry emitted
        expect(sut).toHaveLength(1);
        expect(sut[0]?.path).toBe('k');
        expect(sut[0]?.flags.stage).toBe(3);
      });
    });
  });

  describe('Given a distinct-types conflict with no theirId set', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then emits only stage 2 entry at ourPath', () => {
        // Arrange — partial distinct-types: theirId absent, only ours present
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'm' as FilePath,
              ourPath: 'm~HEAD' as FilePath,
              theirPath: 'm' as FilePath,
              ourId: ID_A,
              ourMode: FILE_MODE.REGULAR,
            }),
          ],
          zeroStat,
        );

        // Assert — only ours entry emitted
        expect(sut).toHaveLength(1);
        expect(sut[0]?.path).toBe('m~HEAD');
        expect(sut[0]?.flags.stage).toBe(2);
      });
    });
  });

  describe('Given a distinct-types conflict with only theirPath set (ourPath absent)', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then recordedPaths uses only theirPath for dedup', () => {
        // Arrange — ourPath absent, so only theirPath is the recorded path;
        // a second conflict at that same path must still refuse
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({
            type: 'distinct-types',
            path: 'n' as FilePath,
            theirPath: 'n' as FilePath,
            theirId: ID_C,
            theirMode: FILE_MODE.SYMLINK,
          }),
          conflict({
            path: 'n' as FilePath,
            ourId: ID_A,
            ourMode: FILE_MODE.REGULAR,
          }),
        ];

        // Act
        let thrown: unknown;
        try {
          conflictsToIndexEntries(conflicts, zeroStat);
        } catch (e) {
          thrown = e;
        }

        // Assert
        expect((thrown as { data: { code: string } }).data.code).toBe('INVALID_DIFF_INPUT');
      });
    });
  });

  describe('Given a with-base distinct-types conflict whose base is a regular file (S1 shape)', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then the base entry is emitted at stage 1 at basePath alongside stage 2', () => {
        // Arrange — S1: base=file, ours=file (renamed to f~HEAD), theirs=symlink (stays at f)
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'f' as FilePath,
              ourPath: 'f~HEAD' as FilePath,
              theirPath: 'f' as FilePath,
              basePath: 'f~HEAD' as FilePath,
              baseId: ID_A,
              baseMode: FILE_MODE.REGULAR,
              ourId: ID_B,
              ourMode: FILE_MODE.REGULAR,
              theirId: ID_C,
              theirMode: FILE_MODE.SYMLINK,
            }),
          ],
          zeroStat,
        );

        // Assert — exactly three entries in path-then-stage order
        expect(sut).toHaveLength(3);
        expect(sut[0]?.path).toBe('f');
        expect(sut[0]?.flags.stage).toBe(3);
        expect(sut[0]?.id).toBe(ID_C);
        expect(sut[0]?.mode).toBe(FILE_MODE.SYMLINK);
        expect(sut[1]?.path).toBe('f~HEAD');
        expect(sut[1]?.flags.stage).toBe(1);
        expect(sut[1]?.id).toBe(ID_A);
        expect(sut[1]?.mode).toBe(FILE_MODE.REGULAR);
        expect(sut[2]?.path).toBe('f~HEAD');
        expect(sut[2]?.flags.stage).toBe(2);
        expect(sut[2]?.id).toBe(ID_B);
        expect(sut[2]?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given a with-base distinct-types conflict whose base is a symlink (S3 shape)', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then the base stage-1 is at the symlink path alongside stage 2, regular side at f~B', () => {
        // Arrange — S3: base=symlink, ours=symlink (stays at f), theirs=file (renamed to f~B)
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'f' as FilePath,
              ourPath: 'f' as FilePath,
              theirPath: 'f~B' as FilePath,
              basePath: 'f' as FilePath,
              baseId: ID_A,
              baseMode: FILE_MODE.SYMLINK,
              ourId: ID_B,
              ourMode: FILE_MODE.SYMLINK,
              theirId: ID_C,
              theirMode: FILE_MODE.REGULAR,
            }),
          ],
          zeroStat,
        );

        // Assert — exactly three entries: f:1, f:2, f~B:3
        expect(sut).toHaveLength(3);
        expect(sut[0]?.path).toBe('f');
        expect(sut[0]?.flags.stage).toBe(1);
        expect(sut[0]?.id).toBe(ID_A);
        expect(sut[0]?.mode).toBe(FILE_MODE.SYMLINK);
        expect(sut[1]?.path).toBe('f');
        expect(sut[1]?.flags.stage).toBe(2);
        expect(sut[1]?.id).toBe(ID_B);
        expect(sut[1]?.mode).toBe(FILE_MODE.SYMLINK);
        expect(sut[2]?.path).toBe('f~B');
        expect(sut[2]?.flags.stage).toBe(3);
        expect(sut[2]?.id).toBe(ID_C);
        expect(sut[2]?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given a with-base distinct-types conflict with basePath set but baseId absent', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then no stage-1 entry is emitted', () => {
        // Arrange — basePath present but baseId missing → guard prevents emission
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'f' as FilePath,
              ourPath: 'f~HEAD' as FilePath,
              theirPath: 'f' as FilePath,
              basePath: 'f~HEAD' as FilePath,
              // baseId intentionally absent
              baseMode: FILE_MODE.REGULAR,
              ourId: ID_B,
              ourMode: FILE_MODE.REGULAR,
              theirId: ID_C,
              theirMode: FILE_MODE.SYMLINK,
            }),
          ],
          zeroStat,
        );

        // Assert — two entries only (stages 2 and 3), no stage 1
        expect(sut).toHaveLength(2);
        expect(sut.every((e) => e.flags.stage !== 1)).toBe(true);
      });
    });
  });

  describe('Given a with-base distinct-types conflict with baseId set but basePath absent', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then no stage-1 entry is emitted', () => {
        // Arrange — baseId/baseMode present but basePath missing → guard prevents emission
        const sut = conflictsToIndexEntries(
          [
            conflict({
              type: 'distinct-types',
              path: 'f' as FilePath,
              ourPath: 'f~HEAD' as FilePath,
              theirPath: 'f' as FilePath,
              // basePath intentionally absent
              baseId: ID_D,
              baseMode: FILE_MODE.REGULAR,
              ourId: ID_B,
              ourMode: FILE_MODE.REGULAR,
              theirId: ID_C,
              theirMode: FILE_MODE.SYMLINK,
            }),
          ],
          zeroStat,
        );

        // Assert — two entries only (stages 2 and 3), no stage 1
        expect(sut).toHaveLength(2);
        expect(sut.every((e) => e.flags.stage !== 1)).toBe(true);
      });
    });
  });

  describe('Given a distinct-types conflict with only ourPath set (theirPath absent)', () => {
    describe('When conflictsToIndexEntries called', () => {
      it('Then recordedPaths uses only ourPath for dedup', () => {
        // Arrange — theirPath absent, so only ourPath is the recorded path;
        // a second conflict at that path must refuse
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({
            type: 'distinct-types',
            path: 'p' as FilePath,
            ourPath: 'p~HEAD' as FilePath,
            ourId: ID_A,
            ourMode: FILE_MODE.REGULAR,
          }),
          conflict({
            path: 'p~HEAD' as FilePath,
            ourId: ID_C,
            ourMode: FILE_MODE.REGULAR,
          }),
        ];

        // Act
        let thrown: unknown;
        try {
          conflictsToIndexEntries(conflicts, zeroStat);
        } catch (e) {
          thrown = e;
        }

        // Assert
        expect((thrown as { data: { code: string } }).data.code).toBe('INVALID_DIFF_INPUT');
      });
    });
  });
});

describe('sortedRecordedPaths', () => {
  function conflict(partial: Partial<MergeConflict> & { path: FilePath }): MergeConflict {
    return {
      type: 'content',
      ...partial,
    } as MergeConflict;
  }

  describe('Given a mix of a distinct-types conflict and a regular conflict', () => {
    describe('When sortedRecordedPaths called', () => {
      it('Then it lists every recorded path byte-sorted', () => {
        // Arrange — distinct-types at `p` with ourPath `p~HEAD` + theirPath `p`;
        // a regular conflict at `a`. flatMap order puts distinct-types first
        // (killing the sort mutation: unsorted would yield `p`, `p~HEAD`, `a`).
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({
            type: 'distinct-types',
            path: 'p' as FilePath,
            ourPath: 'p~HEAD' as FilePath,
            theirPath: 'p' as FilePath,
          }),
          conflict({ path: 'a' as FilePath }),
        ];

        // Act
        const sut = sortedRecordedPaths;
        const result = sut(conflicts);

        // Assert
        expect(result).toEqual(['a', 'p', 'p~HEAD']);
      });
    });
  });

  describe('Given a regular conflict', () => {
    describe('When sortedRecordedPaths called', () => {
      it('Then it returns the single conflict path', () => {
        // Arrange
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({ path: 'file.txt' as FilePath }),
        ];

        // Act
        const sut = sortedRecordedPaths;
        const result = sut(conflicts);

        // Assert
        expect(result).toEqual(['file.txt']);
      });
    });
  });

  describe('Given a distinct-types conflict with only ourPath set', () => {
    describe('When sortedRecordedPaths called', () => {
      it('Then it returns only the present recorded path', () => {
        // Arrange
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({
            type: 'distinct-types',
            path: 'q' as FilePath,
            ourPath: 'q~HEAD' as FilePath,
          }),
        ];

        // Act
        const sut = sortedRecordedPaths;
        const result = sut(conflicts);

        // Assert
        expect(result).toEqual(['q~HEAD']);
      });
    });
  });

  describe('Given a distinct-types conflict with only theirPath set', () => {
    describe('When sortedRecordedPaths called', () => {
      it('Then it returns only the present recorded path', () => {
        // Arrange
        const conflicts: ReadonlyArray<MergeConflict> = [
          conflict({
            type: 'distinct-types',
            path: 'r' as FilePath,
            theirPath: 'r' as FilePath,
          }),
        ];

        // Act
        const sut = sortedRecordedPaths;
        const result = sut(conflicts);

        // Assert
        expect(result).toEqual(['r']);
      });
    });
  });
});

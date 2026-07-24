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
  describe('Given an index/tree pair producing no changes', () => {
    describe('When diffIndexAgainstTree called', () => {
      it.each([
        {
          idx: index([]),
          tree: undefined,
          label: 'empty index + empty tree yields empty TreeDiff',
        },
        {
          idx: index([entry('foo', ID_A, FILE_MODE.REGULAR, 0)]),
          tree: flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
          label: 'stage-0 entries matching the tree exactly yield empty TreeDiff',
        },
        {
          idx: index([]),
          // simulates a FlatTree at exactly the cap; the cap check uses >, so size === cap must pass
          tree: {
            entries: {
              get: () => undefined,
              keys: () => [][Symbol.iterator](),
              size: MAX_FLAT_TREE_ENTRIES,
            } as unknown as ReadonlyMap<FilePath, FlatTreeEntry>,
          },
          label: 'a FlatTree with exactly MAX_FLAT_TREE_ENTRIES entries succeeds without throwing',
        },
      ])('Then $label', ({ idx, tree }) => {
        // Arrange + Act
        const sut = diffIndexAgainstTree(idx, tree);

        // Assert
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given an index/tree pair producing exactly one change', () => {
    describe('When diffIndexAgainstTree called', () => {
      it.each([
        {
          // index has stages 1, 2, 3 for 'conflict'; nothing at stage 0 matches 'conflict' path,
          // so the tree entry (no stage-0 match) yields a delete.
          label: 'stage 1/2/3 unmerged entries are skipped',
          idx: index([
            entry('conflict', ID_A, FILE_MODE.REGULAR, 1),
            entry('conflict', ID_B, FILE_MODE.REGULAR, 2),
            entry('conflict', ID_C, FILE_MODE.REGULAR, 3),
          ]),
          tree: flatTree([['conflict', ID_A, FILE_MODE.REGULAR]]),
          expected: {
            type: 'delete',
            oldPath: 'conflict',
            oldId: ID_A,
            oldMode: FILE_MODE.REGULAR,
          },
        },
        {
          label: 'a path in the tree but not the index emits a DeleteChange',
          idx: index([]),
          tree: flatTree([['gone', ID_A, FILE_MODE.REGULAR]]),
          expected: { type: 'delete', oldPath: 'gone', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
        },
        {
          label: 'a path in the index but not the tree emits an AddChange',
          idx: index([entry('new', ID_A, FILE_MODE.REGULAR, 0)]),
          tree: undefined,
          expected: { type: 'add', newPath: 'new', newId: ID_A, newMode: FILE_MODE.REGULAR },
        },
        {
          label: 'the same path with a different id (same kind) emits a ModifyChange',
          idx: index([entry('foo', ID_B, FILE_MODE.REGULAR, 0)]),
          tree: flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
          expected: {
            type: 'modify',
            path: 'foo',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
        },
        {
          label: 'the same path with a different kind (file → symlink) emits a TypeChangeChange',
          idx: index([entry('foo', ID_B, FILE_MODE.SYMLINK, 0)]),
          tree: flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
          expected: {
            type: 'type-change',
            path: 'foo',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        },
        {
          label:
            'the same path file (tree) → gitlink (index) emits a TypeChangeChange with oldMode REGULAR and newMode GITLINK',
          idx: index([entry('sub', ID_B, FILE_MODE.GITLINK, 0)]),
          tree: flatTree([['sub', ID_A, FILE_MODE.REGULAR]]),
          expected: {
            type: 'type-change',
            path: 'sub',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.GITLINK,
          },
        },
        {
          label:
            'the same path symlink (tree) → gitlink (index) emits a TypeChangeChange with oldMode SYMLINK and newMode GITLINK',
          idx: index([entry('sub', ID_B, FILE_MODE.GITLINK, 0)]),
          tree: flatTree([['sub', ID_A, FILE_MODE.SYMLINK]]),
          expected: {
            type: 'type-change',
            path: 'sub',
            oldId: ID_A,
            newId: ID_B,
            oldMode: FILE_MODE.SYMLINK,
            newMode: FILE_MODE.GITLINK,
          },
        },
        {
          // identical id, REGULAR -> EXECUTABLE: ids match so a `true`-mutated mode guard
          // would treat it as unchanged and emit nothing.
          label:
            'the same id but a different mode (same kind) still emits a ModifyChange (the mode-equality guard is not skipped)',
          idx: index([entry('foo', ID_A, FILE_MODE.EXECUTABLE, 0)]),
          tree: flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
          expected: {
            type: 'modify',
            path: 'foo',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
          },
        },
        {
          label:
            'the same id but a different kind of mode emits a TypeChangeChange (mode guard still evaluated when ids match)',
          idx: index([entry('foo', ID_A, FILE_MODE.SYMLINK, 0)]),
          tree: flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
          expected: {
            type: 'type-change',
            path: 'foo',
            oldId: ID_A,
            newId: ID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.SYMLINK,
          },
        },
      ])('Then $label', ({ idx, tree, expected }) => {
        // Arrange + Act
        const sut = diffIndexAgainstTree(idx, tree);

        // Assert
        expect(sut.changes).toEqual([expected]);
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
          if (c.type === 'rename' || c.type === 'copy') return c.newPath;
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

  describe('Given an index with a partial stage grouping for one path', () => {
    describe('When groupUnmergedEntries called', () => {
      it.each([
        {
          entries: [entry('c', ID_B, FILE_MODE.REGULAR, 2)],
          path: 'c',
          stage1: undefined,
          stage2: ID_B,
          stage3: undefined,
          label: 'only stage 2 present: unmerged entry has stage2 only; no throw (forgiving)',
        },
        {
          entries: [entry('c', ID_A, FILE_MODE.REGULAR, 1)],
          path: 'c',
          stage1: ID_A,
          stage2: undefined,
          stage3: undefined,
          label: 'only stage 1 present: unmerged entry has stage1 only; no throw',
        },
        {
          entries: [entry('c', ID_A, FILE_MODE.REGULAR, 1), entry('c', ID_C, FILE_MODE.REGULAR, 3)],
          path: 'c',
          stage1: ID_A,
          stage2: undefined,
          stage3: ID_C,
          label: 'stages 1 + 3 only (no stage 2): stage2 absent',
        },
      ])('Then $label', ({ entries, path, stage1, stage2, stage3 }) => {
        // Arrange + Act
        const sut = groupUnmergedEntries(index(entries));

        // Assert
        const group = sut.unmerged.get(path as FilePath);
        expect(group?.stage1?.id).toBe(stage1);
        expect(group?.stage2?.id).toBe(stage2);
        expect(group?.stage3?.id).toBe(stage3);
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

  describe('Given a single conflict', () => {
    describe('When sortedRecordedPaths called', () => {
      it.each([
        {
          conflicts: [conflict({ path: 'file.txt' as FilePath })],
          expected: ['file.txt'],
          label: 'a regular conflict returns the single conflict path',
        },
        {
          conflicts: [
            conflict({
              type: 'distinct-types',
              path: 'q' as FilePath,
              ourPath: 'q~HEAD' as FilePath,
            }),
          ],
          expected: ['q~HEAD'],
          label:
            'a distinct-types conflict with only ourPath set returns only the present recorded path',
        },
        {
          conflicts: [
            conflict({
              type: 'distinct-types',
              path: 'r' as FilePath,
              theirPath: 'r' as FilePath,
            }),
          ],
          expected: ['r'],
          label:
            'a distinct-types conflict with only theirPath set returns only the present recorded path',
        },
      ])('Then $label', ({ conflicts, expected }) => {
        // Arrange + Act
        const result = sortedRecordedPaths(conflicts);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

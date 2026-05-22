import { describe, expect, it } from 'vitest';
import type { FlatTree, FlatTreeEntry } from '../../../../src/domain/diff/flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from '../../../../src/domain/diff/flat-tree.js';
import {
  conflictsToIndexEntries,
  diffIndexAgainstTree,
  groupUnmergedEntries,
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
  return { version: 2, entries, extensions: [] };
}

function flatTree(pairs: ReadonlyArray<readonly [string, ObjectId, FileMode]>): FlatTree {
  const map = new Map<FilePath, FlatTreeEntry>();
  for (const [path, id, mode] of pairs) {
    map.set(path as FilePath, { id, mode });
  }
  return { entries: map };
}

describe('diffIndexAgainstTree', () => {
  it('Given empty index + empty tree, When diffIndexAgainstTree called, Then empty TreeDiff', () => {
    // Arrange & Act
    const sut = diffIndexAgainstTree(index([]), undefined);

    // Assert
    expect(sut.changes).toEqual([]);
  });

  it('Given only stage-0 entries matching tree exactly, When diffIndexAgainstTree called, Then empty TreeDiff', () => {
    // Arrange & Act
    const sut = diffIndexAgainstTree(
      index([entry('foo', ID_A, FILE_MODE.REGULAR, 0)]),
      flatTree([['foo', ID_A, FILE_MODE.REGULAR]]),
    );

    // Assert
    expect(sut.changes).toEqual([]);
  });

  it('Given index with stage 1/2/3 unmerged entries, When diffIndexAgainstTree called, Then those entries skipped', () => {
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

  it('Given path in tree but not index, When diffIndexAgainstTree called, Then DeleteChange emitted', () => {
    // Arrange & Act
    const sut = diffIndexAgainstTree(index([]), flatTree([['gone', ID_A, FILE_MODE.REGULAR]]));

    // Assert
    expect(sut.changes).toEqual([
      { type: 'delete', oldPath: 'gone', oldId: ID_A, oldMode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given path in index but not tree, When diffIndexAgainstTree called, Then AddChange emitted', () => {
    // Arrange & Act
    const sut = diffIndexAgainstTree(index([entry('new', ID_A, FILE_MODE.REGULAR, 0)]), undefined);

    // Assert
    expect(sut.changes).toEqual([
      { type: 'add', newPath: 'new', newId: ID_A, newMode: FILE_MODE.REGULAR },
    ]);
  });

  it('Given same path with different id (same kind), When diffIndexAgainstTree called, Then ModifyChange', () => {
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

  it('Given same path with different kind, When diffIndexAgainstTree called, Then TypeChangeChange', () => {
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

  it('Given same id but a DIFFERENT mode (same kind), When diffIndexAgainstTree called, Then ModifyChange (the mode-equality guard is not skipped)', () => {
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

  it('Given same id but a DIFFERENT kind of mode, When diffIndexAgainstTree called, Then TypeChangeChange (mode guard still evaluated when ids match)', () => {
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

  it('Given FlatTree with MAX_FLAT_TREE_ENTRIES + 1 entries, When diffIndexAgainstTree called, Then throws INVALID_TREE_FOR_DIFF', () => {
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
    expect((thrown as { data: { reason: string } }).data.reason).toContain('MAX_FLAT_TREE_ENTRIES');
  });

  it('Given FlatTree with exactly MAX_FLAT_TREE_ENTRIES entries, When diffIndexAgainstTree called, Then succeeds without throwing', () => {
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

  it('Given mixed case output, When diffIndexAgainstTree called, Then changes sorted byte-order on primary path key', () => {
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

describe('groupUnmergedEntries', () => {
  it('Given index with only stage-0 entries, When groupUnmergedEntries called, Then staged populated and unmerged empty', () => {
    // Arrange & Act
    const sut = groupUnmergedEntries(index([entry('foo', ID_A, FILE_MODE.REGULAR, 0)]));

    // Assert
    expect(sut.staged).toHaveLength(1);
    expect(sut.unmerged.size).toBe(0);
  });

  it('Given index with stages 1, 2, 3 for one path, When groupUnmergedEntries called, Then unmerged entry contains all three', () => {
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

  it('Given index with only stage 2 for a path, When groupUnmergedEntries called, Then unmerged entry has stage2 only; no throw (forgiving)', () => {
    // Arrange & Act
    const sut = groupUnmergedEntries(index([entry('c', ID_B, FILE_MODE.REGULAR, 2)]));

    // Assert
    const group = sut.unmerged.get('c' as FilePath);
    expect(group?.stage1).toBeUndefined();
    expect(group?.stage2?.id).toBe(ID_B);
    expect(group?.stage3).toBeUndefined();
  });

  it('Given index with only stage 1 for a path, When groupUnmergedEntries called, Then unmerged entry has stage1 only; no throw', () => {
    // Arrange & Act
    const sut = groupUnmergedEntries(index([entry('c', ID_A, FILE_MODE.REGULAR, 1)]));

    // Assert
    const group = sut.unmerged.get('c' as FilePath);
    expect(group?.stage1?.id).toBe(ID_A);
    expect(group?.stage2).toBeUndefined();
    expect(group?.stage3).toBeUndefined();
  });

  it('Given index with stages 1 + 3 only (no stage 2), When groupUnmergedEntries called, Then stage2 absent', () => {
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

describe('conflictsToIndexEntries', () => {
  function conflict(partial: Partial<MergeConflict> & { path: FilePath }): MergeConflict {
    return {
      type: 'content',
      ...partial,
    } as MergeConflict;
  }

  it('Given one conflict with baseId/ourId/theirId all set, When conflictsToIndexEntries called, Then 3 entries emitted in (path, stage) byte-order', () => {
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

  it('Given one conflict with only ourId set, When conflictsToIndexEntries called, Then the emitted entry flags are assumeValid=false and skipWorktree=false', () => {
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

  it('Given one conflict with only ourId set, When conflictsToIndexEntries called, Then 1 entry at stage 2', () => {
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

  it('Given one conflict with no ids set, When conflictsToIndexEntries called, Then 0 entries emitted', () => {
    // Arrange
    const sut = conflictsToIndexEntries([conflict({ path: 'file' as FilePath })], zeroStat);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given two conflicts sharing same path, When conflictsToIndexEntries called, Then throws INVALID_DIFF_INPUT', () => {
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

  it('Given conflict with distinct baseMode / ourMode / theirMode, When conflictsToIndexEntries called, Then statFactory invoked per stage with its mode', () => {
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

  it('Given multiple conflicts, When conflictsToIndexEntries called, Then entries sorted by (path, stage) byte-order', () => {
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

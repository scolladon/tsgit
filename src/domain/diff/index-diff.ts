import { type GitIndex, type IndexEntry, STAGE0_FLAGS, type StatData } from '../git-index/index.js';
import type { MergeConflict } from '../merge/merge-types.js';
import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { primaryPath } from './change-path.js';
import type { DiffChange, TreeDiff } from './diff-change.js';
import { invalidDiffInput, invalidTreeForDiff } from './error.js';
import type { FlatTree, FlatTreeEntry } from './flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from './flat-tree.js';
import { isSameKind } from './mode-kind.js';
import { comparePaths, sortByPath } from './path-compare.js';

export interface UnmergedEntryGroup {
  readonly stage1?: IndexEntry;
  readonly stage2?: IndexEntry;
  readonly stage3?: IndexEntry;
}

export interface GroupedIndex {
  readonly staged: ReadonlyArray<IndexEntry>;
  readonly unmerged: ReadonlyMap<FilePath, UnmergedEntryGroup>;
}

function stage0IndexMap(index: GitIndex): Map<FilePath, IndexEntry> {
  const map = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) {
    if (entry.flags.stage === 0) map.set(entry.path, entry);
  }
  return map;
}

function addFromIndex(entry: IndexEntry): DiffChange {
  return { type: 'add', newPath: entry.path, newId: entry.id, newMode: entry.mode };
}

function deleteFromTree(path: FilePath, treeEntry: FlatTreeEntry): DiffChange {
  return { type: 'delete', oldPath: path, oldId: treeEntry.id, oldMode: treeEntry.mode };
}

function classifyIndexVsTree(
  path: FilePath,
  indexEntry: IndexEntry,
  treeEntry: FlatTreeEntry,
): DiffChange | undefined {
  if (indexEntry.id === treeEntry.id && indexEntry.mode === treeEntry.mode) return undefined;
  if (!isSameKind(indexEntry.mode, treeEntry.mode)) {
    return {
      type: 'type-change',
      path,
      oldId: treeEntry.id,
      newId: indexEntry.id,
      oldMode: treeEntry.mode,
      newMode: indexEntry.mode,
    };
  }
  return {
    type: 'modify',
    path,
    oldId: treeEntry.id,
    newId: indexEntry.id,
    oldMode: treeEntry.mode,
    newMode: indexEntry.mode,
  };
}

function enforceTreeCap(tree: FlatTree | undefined): void {
  if (tree !== undefined && tree.entries.size > MAX_FLAT_TREE_ENTRIES) {
    throw invalidTreeForDiff('FlatTree exceeds MAX_FLAT_TREE_ENTRIES');
  }
}

function unionPaths(
  indexMap: ReadonlyMap<FilePath, IndexEntry>,
  tree: FlatTree | undefined,
): Set<FilePath> {
  const paths = new Set<FilePath>();
  for (const path of indexMap.keys()) paths.add(path);
  if (tree !== undefined) {
    for (const path of tree.entries.keys()) paths.add(path);
  }
  return paths;
}

function changeForPath(
  path: FilePath,
  indexEntry: IndexEntry | undefined,
  treeEntry: FlatTreeEntry | undefined,
): DiffChange | undefined {
  if (indexEntry !== undefined && treeEntry !== undefined) {
    return classifyIndexVsTree(path, indexEntry, treeEntry);
  }
  if (indexEntry !== undefined) return addFromIndex(indexEntry);
  // `allPaths` is built from the union of indexMap and tree entries, so at least one is defined.
  return deleteFromTree(path, treeEntry!);
}

export function diffIndexAgainstTree(index: GitIndex, tree: FlatTree | undefined): TreeDiff {
  enforceTreeCap(tree);
  const indexMap = stage0IndexMap(index);
  const allPaths = unionPaths(indexMap, tree);

  const changes: DiffChange[] = [];
  for (const path of allPaths) {
    const change = changeForPath(path, indexMap.get(path), tree?.entries.get(path));
    if (change !== undefined) changes.push(change);
  }
  return { changes: sortByPath(changes, primaryPath) };
}

function assignStage(group: UnmergedEntryGroup, entry: IndexEntry): UnmergedEntryGroup {
  const stage = entry.flags.stage;
  if (stage === 1) return { ...group, stage1: entry };
  if (stage === 2) return { ...group, stage2: entry };
  return { ...group, stage3: entry };
}

export function groupUnmergedEntries(index: GitIndex): GroupedIndex {
  const staged: IndexEntry[] = [];
  const unmerged = new Map<FilePath, UnmergedEntryGroup>();
  for (const entry of index.entries) {
    if (entry.flags.stage === 0) {
      staged.push(entry);
    } else {
      const current = unmerged.get(entry.path) ?? {};
      unmerged.set(entry.path, assignStage(current, entry));
    }
  }
  return { staged, unmerged };
}

interface StageEmission {
  readonly id: ObjectId;
  readonly mode: FileMode;
  readonly stage: 1 | 2 | 3;
  readonly path: FilePath;
}

function conflictStageEmissions(conflict: MergeConflict): ReadonlyArray<StageEmission> {
  if (conflict.type === 'distinct-types') {
    return distinctTypesEmissions(conflict);
  }
  return regularEmissions(conflict);
}

function distinctTypesEmissions(conflict: MergeConflict): ReadonlyArray<StageEmission> {
  const out: StageEmission[] = [];
  if (
    conflict.ourId !== undefined &&
    conflict.ourMode !== undefined &&
    conflict.ourPath !== undefined
  ) {
    out.push({ id: conflict.ourId, mode: conflict.ourMode, stage: 2, path: conflict.ourPath });
  }
  if (
    conflict.theirId !== undefined &&
    conflict.theirMode !== undefined &&
    conflict.theirPath !== undefined
  ) {
    out.push({
      id: conflict.theirId,
      mode: conflict.theirMode,
      stage: 3,
      path: conflict.theirPath,
    });
  }
  return out;
}

function regularEmissions(conflict: MergeConflict): ReadonlyArray<StageEmission> {
  const out: StageEmission[] = [];
  if (conflict.baseId !== undefined && conflict.baseMode !== undefined) {
    out.push({ id: conflict.baseId, mode: conflict.baseMode, stage: 1, path: conflict.path });
  }
  if (conflict.ourId !== undefined && conflict.ourMode !== undefined) {
    out.push({ id: conflict.ourId, mode: conflict.ourMode, stage: 2, path: conflict.path });
  }
  if (conflict.theirId !== undefined && conflict.theirMode !== undefined) {
    out.push({ id: conflict.theirId, mode: conflict.theirMode, stage: 3, path: conflict.path });
  }
  return out;
}

function recordedPaths(conflict: MergeConflict): ReadonlyArray<FilePath> {
  if (conflict.type === 'distinct-types') {
    const paths: FilePath[] = [];
    if (conflict.ourPath !== undefined) paths.push(conflict.ourPath);
    if (conflict.theirPath !== undefined) paths.push(conflict.theirPath);
    return paths;
  }
  return [conflict.path];
}

function toIndexEntry(
  emission: StageEmission,
  statFactory: (mode: FileMode) => StatData,
): IndexEntry {
  const stat = statFactory(emission.mode);
  return {
    ctimeSeconds: stat.ctimeSeconds,
    ctimeNanoseconds: stat.ctimeNanoseconds,
    mtimeSeconds: stat.mtimeSeconds,
    mtimeNanoseconds: stat.mtimeNanoseconds,
    dev: stat.dev,
    ino: stat.ino,
    mode: emission.mode,
    uid: stat.uid,
    gid: stat.gid,
    fileSize: stat.fileSize,
    id: emission.id,
    flags: { ...STAGE0_FLAGS, stage: emission.stage },
    path: emission.path,
  };
}

export function conflictsToIndexEntries(
  conflicts: ReadonlyArray<MergeConflict>,
  statFactory: (mode: FileMode) => StatData,
): ReadonlyArray<IndexEntry> {
  const seenPaths = new Set<FilePath>();
  for (const conflict of conflicts) {
    for (const path of recordedPaths(conflict)) {
      if (seenPaths.has(path)) {
        throw invalidDiffInput('duplicate conflict path');
      }
      seenPaths.add(path);
    }
  }

  const entries: IndexEntry[] = [];
  for (const conflict of conflicts) {
    for (const emission of conflictStageEmissions(conflict)) {
      entries.push(toIndexEntry(emission, statFactory));
    }
  }
  entries.sort((a, b) => {
    const pathCmp = comparePaths(a.path, b.path);
    // Stryker disable next-line ConditionalExpression: equivalent — same-path entries only ever come from one conflict (recorded paths are deduplicated above, and a distinct-types conflict emits each side at its own path) and are pushed in ascending stage order; with `true` the comparator returns 0 for them and V8's spec-stable sort preserves that already-ascending insertion order, yielding identical output.
    if (pathCmp !== 0) return pathCmp;
    // Stryker disable next-line ArithmeticOperator: equivalent — same-path runs are always pushed pre-sorted ascending by stage (regular conflicts emit 1→2→3, distinct-types one stage per path, duplicates rejected above), so the comparator never has to reorder them; `+` and `-` both leave the already-ascending run in place.
    return a.flags.stage - b.flags.stage;
  });
  return entries;
}

/**
 * Pure helper that diffs a current GitIndex against a target tree's flat
 * entry list and emits an ordered ChangesetEntry list. No FS, no ctx; the
 * impure write side lives in `apply-changeset.ts`.
 *
 * Stage-0 entries only — unmerged stages are invisible to checkout (Phase
 * 13.1 design step 5).
 */
import type { GitIndex } from '../../domain/git-index/index.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';

export interface ChangesetEntry {
  readonly kind: 'add' | 'update' | 'delete' | 'noop';
  readonly path: FilePath;
  readonly mode: FileMode;
  readonly id: ObjectId | undefined;
  readonly previousId: ObjectId | undefined;
  readonly previousMode: FileMode | undefined;
}

export interface ChangesetStats {
  readonly add: number;
  readonly update: number;
  readonly delete: number;
  readonly noop: number;
}

export interface Changeset {
  readonly entries: ReadonlyArray<ChangesetEntry>;
  readonly stats: ChangesetStats;
}

interface TargetEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface IndexProjection {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const projectIndex = (currentIndex: GitIndex): Map<FilePath, IndexProjection> => {
  const indexByPath = new Map<FilePath, IndexProjection>();
  for (const entry of currentIndex.entries) {
    if (entry.flags.stage !== 0) continue;
    indexByPath.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  return indexByPath;
};

const projectTarget = (targetTree: ReadonlyArray<TargetEntry>): Map<FilePath, TargetEntry> => {
  const targetByPath = new Map<FilePath, TargetEntry>();
  for (const t of targetTree) targetByPath.set(t.path, t);
  return targetByPath;
};

const classify = (
  path: FilePath,
  indexEntry: IndexProjection | undefined,
  targetEntry: TargetEntry | undefined,
): ChangesetEntry => {
  if (indexEntry === undefined && targetEntry !== undefined) {
    return {
      kind: 'add',
      path,
      mode: targetEntry.mode,
      id: targetEntry.id,
      previousId: undefined,
      previousMode: undefined,
    };
  }
  if (indexEntry !== undefined && targetEntry === undefined) {
    return {
      kind: 'delete',
      path,
      mode: indexEntry.mode,
      id: undefined,
      previousId: indexEntry.id,
      previousMode: indexEntry.mode,
    };
  }
  // Both present (the all-absent case never reaches us — we iterate the union).
  const idx = indexEntry as IndexProjection;
  const tgt = targetEntry as TargetEntry;
  const unchanged = idx.id === tgt.id && idx.mode === tgt.mode;
  return {
    kind: unchanged ? 'noop' : 'update',
    path,
    mode: tgt.mode,
    id: tgt.id,
    previousId: idx.id,
    previousMode: idx.mode,
  };
};

export const computeChangeset = (
  currentIndex: GitIndex,
  targetTree: ReadonlyArray<TargetEntry>,
): Changeset => {
  const indexByPath = projectIndex(currentIndex);
  const targetByPath = projectTarget(targetTree);

  const allPaths = new Set<FilePath>();
  for (const p of indexByPath.keys()) allPaths.add(p);
  for (const p of targetByPath.keys()) allPaths.add(p);

  const entries: ChangesetEntry[] = [];
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };

  for (const path of [...allPaths].sort()) {
    const entry = classify(path, indexByPath.get(path), targetByPath.get(path));
    entries.push(entry);
    if (entry.kind === 'delete') stats.delete += 1;
    else stats[entry.kind] += 1;
  }

  return { entries, stats };
};

/**
 * Pure helper that diffs a current GitIndex against a target tree's flat
 * entry list and emits an ordered ChangesetEntry list. No FS, no ctx; the
 * impure write side lives in `apply-changeset.ts`.
 *
 * Stage-0 entries only — unmerged stages are invisible to checkout (Phase
 * 13.1 design step 5).
 */
import type { GitIndex } from '../../domain/git-index/index.js';
import { type IndexPathKey, indexPathKey } from '../../domain/git-index/index-path-key.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';

export interface ChangesetEntry {
  readonly kind: 'add' | 'update' | 'delete' | 'noop';
  readonly path: FilePath;
  /** Raw path bytes when `path` does not re-encode to them; the working-tree write still uses `path`. */
  readonly pathBytes?: Uint8Array;
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
  readonly pathBytes?: Uint8Array;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface IndexProjection {
  readonly path: FilePath;
  readonly pathBytes?: Uint8Array;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const projectIndex = (currentIndex: GitIndex): Map<IndexPathKey, IndexProjection> => {
  const indexByKey = new Map<IndexPathKey, IndexProjection>();
  for (const entry of currentIndex.entries) {
    if (entry.flags.stage !== 0) continue;
    indexByKey.set(indexPathKey(entry), entry);
  }
  return indexByKey;
};

const projectTarget = (targetTree: ReadonlyArray<TargetEntry>): Map<IndexPathKey, TargetEntry> => {
  const targetByKey = new Map<IndexPathKey, TargetEntry>();
  for (const t of targetTree) targetByKey.set(indexPathKey(t), t);
  return targetByKey;
};

const pathFields = (source: {
  readonly path: FilePath;
  readonly pathBytes?: Uint8Array;
}): Pick<ChangesetEntry, 'path' | 'pathBytes'> => ({
  path: source.path,
  ...(source.pathBytes === undefined ? {} : { pathBytes: source.pathBytes }),
});

const classify = (
  indexEntry: IndexProjection | undefined,
  targetEntry: TargetEntry | undefined,
): ChangesetEntry => {
  if (indexEntry === undefined && targetEntry !== undefined) {
    return {
      kind: 'add',
      ...pathFields(targetEntry),
      mode: targetEntry.mode,
      id: targetEntry.id,
      previousId: undefined,
      previousMode: undefined,
    };
  }
  if (indexEntry !== undefined && targetEntry === undefined) {
    return {
      kind: 'delete',
      ...pathFields(indexEntry),
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
    ...pathFields(tgt),
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
  const indexByKey = projectIndex(currentIndex);
  const targetByKey = projectTarget(targetTree);

  const allKeys = new Set<IndexPathKey>();
  for (const k of indexByKey.keys()) allKeys.add(k);
  for (const k of targetByKey.keys()) allKeys.add(k);

  const entries: ChangesetEntry[] = [];
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };

  for (const key of [...allKeys].sort()) {
    const entry = classify(indexByKey.get(key), targetByKey.get(key));
    entries.push(entry);
    stats[entry.kind] += 1;
  }

  return { entries, stats };
};

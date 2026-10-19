/**
 * Pure helper that diffs a current GitIndex against a target tree's flat
 * entry list and emits an ordered ChangesetEntry list. No FS, no ctx; the
 * impure write side lives in `apply-changeset.ts`.
 *
 * Stage-0 entries only — unmerged stages are invisible to checkout (Phase
 * 13.1 design step 5).
 */
import type { GitIndex } from '../../domain/git-index/index.js';
import { compareEntryPath, inOrder } from '../../domain/git-index/index-writer.js';
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

const stage0Ordered = (currentIndex: GitIndex): ReadonlyArray<IndexProjection> =>
  inOrder(
    currentIndex.entries.filter((entry) => entry.flags.stage === 0),
    compareEntryPath,
  );

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

const headOrder = (
  indexEntry: IndexProjection | undefined,
  targetEntry: TargetEntry | undefined,
) => {
  if (indexEntry === undefined) return 1;
  if (targetEntry === undefined) return -1;
  return compareEntryPath(indexEntry, targetEntry);
};

const joinOrdered = (
  indexSide: ReadonlyArray<IndexProjection>,
  targetSide: ReadonlyArray<TargetEntry>,
  emit: (entry: ChangesetEntry) => void,
): void => {
  let i = 0;
  let t = 0;
  while (i < indexSide.length || t < targetSide.length) {
    const indexEntry = indexSide[i];
    const targetEntry = targetSide[t];
    const order = headOrder(indexEntry, targetEntry);
    emit(classify(order <= 0 ? indexEntry : undefined, order >= 0 ? targetEntry : undefined));
    if (order <= 0) i += 1;
    if (order >= 0) t += 1;
  }
};

export const computeChangeset = (
  currentIndex: GitIndex,
  targetTree: ReadonlyArray<TargetEntry>,
): Changeset => {
  const entries: ChangesetEntry[] = [];
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };

  joinOrdered(stage0Ordered(currentIndex), inOrder(targetTree, compareEntryPath), (entry) => {
    entries.push(entry);
    stats[entry.kind] += 1;
  });

  return { entries, stats };
};

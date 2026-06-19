import type { ObjectId } from '../objects/index.js';
import { primaryPath } from './change-path.js';
import type { AddChange, DeleteChange, DiffChange, RenameChange, TreeDiff } from './diff-change.js';
import { sortByPath } from './path-compare.js';
import { MAX_SCORE } from './similarity.js';

export interface RenameDetectOptions {
  readonly limit?: number;
  readonly maxSameIdDeletes?: number;
  readonly threshold?: number;
}

const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_SAME_ID_DELETES = 100;

function partition(changes: ReadonlyArray<DiffChange>): {
  readonly adds: ReadonlyArray<AddChange>;
  readonly deletes: ReadonlyArray<DeleteChange>;
  readonly other: ReadonlyArray<DiffChange>;
} {
  const adds: AddChange[] = [];
  const deletes: DeleteChange[] = [];
  const other: DiffChange[] = [];
  for (const change of changes) {
    if (change.type === 'add') adds.push(change);
    else if (change.type === 'delete') deletes.push(change);
    else other.push(change);
  }
  return { adds, deletes, other };
}

function buildDeletesByOldId(
  deletes: ReadonlyArray<DeleteChange>,
  maxSameIdDeletes: number,
): Map<ObjectId, ReadonlyArray<DeleteChange>> {
  const byOldId = new Map<ObjectId, DeleteChange[]>();
  for (const del of deletes) {
    const list = byOldId.get(del.oldId);
    if (list === undefined) {
      byOldId.set(del.oldId, [del]);
    } else {
      list.push(del);
    }
  }
  // Prune keys exceeding per-id fan-out cap; freeze into read-only shape.
  const pruned = new Map<ObjectId, ReadonlyArray<DeleteChange>>();
  for (const [key, list] of byOldId) {
    if (list.length <= maxSameIdDeletes) pruned.set(key, list);
  }
  return pruned;
}

function tryFoldAdd(
  add: AddChange,
  deletesByOldId: Map<ObjectId, ReadonlyArray<DeleteChange>>,
): { readonly rename: RenameChange; readonly consumedDelete: DeleteChange } | undefined {
  const matches = deletesByOldId.get(add.newId);
  if (matches === undefined || matches.length !== 1) return undefined;
  // length === 1 is guaranteed by the guard above; cast is safe.
  const del = matches[0] as DeleteChange;
  return {
    rename: {
      type: 'rename',
      oldPath: del.oldPath,
      newPath: add.newPath,
      oldId: del.oldId,
      newId: add.newId,
      oldMode: del.oldMode,
      newMode: add.newMode,
      similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
    },
    consumedDelete: del,
  };
}

export function detectRenames(diff: TreeDiff, options: RenameDetectOptions = {}): TreeDiff {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxSameIdDeletes = options.maxSameIdDeletes ?? DEFAULT_MAX_SAME_ID_DELETES;
  const { adds, deletes, other } = partition(diff.changes);

  if (adds.length * deletes.length > limit) return diff;

  const deletesByOldId = buildDeletesByOldId(deletes, maxSameIdDeletes);
  const consumedDeletes = new Set<DeleteChange>();
  const renames: RenameChange[] = [];
  const unfoldedAdds: AddChange[] = [];

  for (const add of adds) {
    const fold = tryFoldAdd(add, deletesByOldId);
    if (fold === undefined) {
      unfoldedAdds.push(add);
    } else {
      renames.push(fold.rename);
      consumedDeletes.add(fold.consumedDelete);
    }
  }

  const unfoldedDeletes = deletes.filter((d) => !consumedDeletes.has(d));
  const merged: DiffChange[] = [...unfoldedAdds, ...unfoldedDeletes, ...renames, ...other];
  return { changes: sortByPath(merged, primaryPath) };
}

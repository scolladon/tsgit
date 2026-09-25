import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { primaryPath } from './change-path.js';
import type { AddChange, DeleteChange, DiffChange, RenameChange, TreeDiff } from './diff-change.js';
import { kindOf } from './mode-kind.js';
import { sortByPath } from './path-compare.js';
import { MAX_SCORE } from './similarity.js';

export interface RenameDetectOptions {
  readonly limit?: number;
  readonly threshold?: number;
  readonly copies?: 'off' | 'on' | 'harder';
  /** Per-copy threshold (0..MAX_SCORE). Defaults to `threshold` when absent. */
  readonly copyThreshold?: number;
  /**
   * Break-rewrite detection (-B).
   * score: dissimilarity gate (>= score → attempt break; default DEFAULT_BREAK_SCORE).
   * merge: keep-broken gate (>= merge → emit broken modify; default DEFAULT_MERGE_SCORE).
   * A merge value of 0 maps to DEFAULT_MERGE_SCORE.
   * false (default) → no break detection.
   */
  readonly breakRewrites?: { readonly score: number; readonly merge: number } | false;
}

const DEFAULT_LIMIT = 1000;
// git's find_identical_files examines at most this many eligible candidates per destination.
const EXACT_CANDIDATE_CAP = 100;
const NOT_FOUND = -1;

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

function buildDeletesByOldId(deletes: ReadonlyArray<DeleteChange>): Map<ObjectId, DeleteChange[]> {
  const byOldId = new Map<ObjectId, DeleteChange[]>();
  for (const del of deletes) {
    const group = byOldId.get(del.oldId);
    if (group === undefined) {
      byOldId.set(del.oldId, [del]);
    } else {
      group.push(del);
    }
  }
  return byOldId;
}

// Both regular (644/755 pair freely) or identical modes (symlink, gitlink, tree).
function isExactModeCompatible(oldMode: FileMode, newMode: FileMode): boolean {
  if (kindOf(oldMode) === 'file' && kindOf(newMode) === 'file') return true;
  return oldMode === newMode;
}

// Last path segment equality; 'Foo' ≡ 'b/Foo', 'xFoo' ≢ 'Foo' (git's basename_same).
function hasSameBasename(oldPath: FilePath, newPath: FilePath): boolean {
  const oldBasename = oldPath.slice(oldPath.lastIndexOf('/') + 1);
  const newBasename = newPath.slice(newPath.lastIndexOf('/') + 1);
  return oldBasename === newBasename;
}

// Transcribes git's find_identical_files: first unused mode-compatible candidate,
// basename match wins immediately, first-in-order candidate wins ties, capped scan.
function pickExactSource(add: AddChange, group: ReadonlyArray<DeleteChange>): number {
  let fallback = NOT_FOUND;
  let examined = 0;
  for (const [index, candidate] of group.entries()) {
    if (examined >= EXACT_CANDIDATE_CAP) break;
    if (!isExactModeCompatible(candidate.oldMode, add.newMode)) continue;
    if (hasSameBasename(candidate.oldPath, add.newPath)) return index;
    if (fallback === NOT_FOUND) fallback = index;
    examined += 1;
  }
  return fallback;
}

function tryFoldAdd(
  add: AddChange,
  deletesByOldId: Map<ObjectId, DeleteChange[]>,
): RenameChange | undefined {
  const group = deletesByOldId.get(add.newId);
  if (group === undefined) return undefined;
  const index = pickExactSource(add, group);
  if (index === NOT_FOUND) return undefined;
  // index came from pickExactSource iterating this exact group; always in bounds.
  const del = group.splice(index, 1)[0] as DeleteChange;
  return {
    type: 'rename',
    oldPath: del.oldPath,
    newPath: add.newPath,
    oldId: del.oldId,
    newId: add.newId,
    oldMode: del.oldMode,
    newMode: add.newMode,
    similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
  };
}

export function detectRenames(diff: TreeDiff, options: RenameDetectOptions = {}): TreeDiff {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const { adds, deletes, other } = partition(diff.changes);

  if (adds.length * deletes.length > limit) return diff;

  const deletesByOldId = buildDeletesByOldId(deletes);
  const renames: RenameChange[] = [];
  const unfoldedAdds: AddChange[] = [];

  for (const add of adds) {
    const rename = tryFoldAdd(add, deletesByOldId);
    if (rename === undefined) {
      unfoldedAdds.push(add);
    } else {
      renames.push(rename);
    }
  }

  // A folded delete was spliced out of its group, so the groups hold exactly the unfolded deletes.
  const unfoldedDeletes = [...deletesByOldId.values()].flat();
  const merged: DiffChange[] = [...unfoldedAdds, ...unfoldedDeletes, ...renames, ...other];
  return { changes: sortByPath(merged, primaryPath) };
}

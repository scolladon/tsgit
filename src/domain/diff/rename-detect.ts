import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { FILE_MODE } from '../objects/index.js';
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

// git's find_identical_files examines at most this many eligible candidates per destination.
const EXACT_CANDIDATE_CAP = 100;

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

// Regular files pair across the executable bit, so both key as REGULAR; every
// other mode pairs only with itself.
function exactKey(id: ObjectId, mode: FileMode): string {
  return `${id} ${kindOf(mode) === 'file' ? FILE_MODE.REGULAR : mode}`;
}

// Bucketing by mode class up front keeps git's candidate order among compatible
// sources while letting the cap bound the scan: incompatible ones are never visited.
// Each group is stored last-candidate-first, so consuming a source near git's scan
// front shifts at most the cap's worth of entries instead of the whole group.
function buildExactSources(deletes: ReadonlyArray<DeleteChange>): Map<string, DeleteChange[]> {
  const byKey = new Map<string, DeleteChange[]>();
  for (const del of deletes) {
    const key = exactKey(del.oldId, del.oldMode);
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, [del]);
    } else {
      group.push(del);
    }
  }
  for (const group of byKey.values()) group.reverse();
  return byKey;
}

// Last path segment equality; 'Foo' ≡ 'b/Foo', 'xFoo' ≢ 'Foo' (git's basename_same).
function hasSameBasename(oldPath: FilePath, newPath: FilePath): boolean {
  const oldBasename = oldPath.slice(oldPath.lastIndexOf('/') + 1);
  const newBasename = newPath.slice(newPath.lastIndexOf('/') + 1);
  return oldBasename === newBasename;
}

// Transcribes git's find_identical_files: a basename match within the capped
// scan wins, otherwise the first candidate in order (the group's tail).
function pickExactSource(add: AddChange, group: ReadonlyArray<DeleteChange>): number {
  const basenameMatch = group
    .slice(-EXACT_CANDIDATE_CAP)
    .reverse()
    .findIndex((candidate) => hasSameBasename(candidate.oldPath, add.newPath));
  return group.length - 1 - Math.max(basenameMatch, 0);
}

/**
 * Removes the chosen source from its group so no later add can pair with it
 * again; an emptied group yields undefined.
 */
function consumeExactSource(
  add: AddChange,
  sources: Map<string, DeleteChange[]>,
): DeleteChange | undefined {
  const group = sources.get(exactKey(add.newId, add.newMode));
  return group?.splice(pickExactSource(add, group), 1)[0];
}

function toExactRename(del: DeleteChange, add: AddChange): RenameChange {
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

// Never gated by a rename limit: git's exact pass always runs, the limit only skips the inexact matrix.
export function detectRenames(diff: TreeDiff): TreeDiff {
  const { adds, deletes, other } = partition(diff.changes);
  const sources = buildExactSources(deletes);
  const renames: RenameChange[] = [];
  const unfoldedAdds: AddChange[] = [];

  for (const add of adds) {
    const source = consumeExactSource(add, sources);
    if (source === undefined) {
      unfoldedAdds.push(add);
    } else {
      renames.push(toExactRename(source, add));
    }
  }

  // Consumed sources were spliced out, so the groups hold exactly the unfolded deletes.
  const unfoldedDeletes = [...sources.values()].flat();
  const merged: DiffChange[] = [...unfoldedAdds, ...unfoldedDeletes, ...renames, ...other];
  return { changes: sortByPath(merged, primaryPath) };
}

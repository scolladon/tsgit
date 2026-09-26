import { primaryPath } from './change-path.js';
import type { AddChange, DeleteChange, DiffChange, RenameChange, TreeDiff } from './diff-change.js';
import { sortByPath } from './path-compare.js';
import type { RenameSource, SourcePair } from './rename-pairing.js';
import { pairIdenticalFiles } from './rename-pairing.js';
import { MAX_SCORE } from './similarity.js';

export interface RenameDetectOptions {
  readonly limit?: number;
  /** Similarity gate (0..MAX_SCORE) for both renames and copies — git's `-M<n>` / `-C<n>`; default 50%. */
  readonly threshold?: number;
  readonly copies?: 'off' | 'on' | 'harder';
  /**
   * Break-rewrite detection (-B).
   * score: dissimilarity gate (>= score → attempt break; default DEFAULT_BREAK_SCORE).
   * merge: keep-broken gate (>= merge → emit broken modify; default DEFAULT_MERGE_SCORE).
   * A merge value of 0 maps to DEFAULT_MERGE_SCORE.
   * false (default) → no break detection.
   */
  readonly breakRewrites?: { readonly score: number; readonly merge: number } | false;
}

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

function toRenameSource(del: DeleteChange): RenameSource {
  return { path: del.oldPath, id: del.oldId, mode: del.oldMode, origin: 'deleted', seedUses: 0 };
}

function toExactRename(sources: ReadonlyArray<RenameSource>, pair: SourcePair): RenameChange {
  const source = sources[pair.source] as RenameSource;
  const destination = pair.destination;
  return {
    type: 'rename',
    oldPath: source.path,
    newPath: destination.newPath,
    oldId: source.id,
    newId: destination.newId,
    oldMode: source.mode,
    newMode: destination.newMode,
    similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
  };
}

// Never gated by a rename limit: git's exact pass always runs, the limit only skips the inexact matrix.
export function detectRenames(diff: TreeDiff): TreeDiff {
  const { adds, deletes, other } = partition(diff.changes);
  const sources = deletes.map(toRenameSource);
  const { pairs, unpaired, uses } = pairIdenticalFiles(sources, adds, 'rename');

  const renames = pairs.map((pair) => toExactRename(sources, pair));
  const unfoldedDeletes = deletes.filter((_, index) => uses[index] === 0);
  const merged: DiffChange[] = [...unpaired, ...unfoldedDeletes, ...renames, ...other];
  return { changes: sortByPath(merged, primaryPath) };
}

import {
  escapedPathOf,
  type IndexPath,
  type IndexPathKey,
  indexPathKey,
} from '../../../domain/git-index/index-path-key.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';

interface Versioned extends IndexPath {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

/** The outcome of git's two-way merge over HEAD, the target and the index. */
export interface TwoWayCarry {
  /** Paths HEAD and the target agree on: the index entry (or its absence) and the work file stay. */
  readonly kept: ReadonlySet<IndexPathKey>;
  /** Paths the index changed to a version that is neither HEAD's nor the target's. */
  readonly refused: ReadonlyArray<FilePath>;
}

const sameVersion = (a: Versioned | undefined, b: Versioned | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.id === b.id && a.mode === b.mode;

const byKey = (entries: ReadonlyArray<Versioned>): Map<IndexPathKey, Versioned> =>
  new Map(entries.map((entry) => [indexPathKey(entry), entry]));

const pathsOf = (...maps: ReadonlyArray<ReadonlyMap<IndexPathKey, Versioned>>): Set<IndexPathKey> =>
  new Set(maps.flatMap((map) => [...map.keys()]));

export const carryStagedChanges = (
  head: ReadonlyArray<Versioned>,
  target: ReadonlyArray<Versioned>,
  index: ReadonlyArray<Versioned>,
): TwoWayCarry => {
  const old = byKey(head);
  const next = byKey(target);
  const staged = byKey(index);
  const kept = new Set<IndexPathKey>();
  const refused: FilePath[] = [];
  for (const key of pathsOf(old, next, staged)) {
    const [o, n, i] = [old.get(key), next.get(key), staged.get(key)];
    if (sameVersion(o, n)) kept.add(key);
    else if (!sameVersion(i, o) && !sameVersion(i, n)) {
      refused.push(escapedPathOf((i ?? n) as Versioned));
    }
  }
  return { kept, refused };
};

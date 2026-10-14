import type { FilePath } from '../objects/index.js';
import type { IndexEntry } from './index-entry.js';
import { pathComparatorFor } from './index-writer.js';

export interface IndexChange {
  readonly changedPaths: ReadonlyArray<FilePath>;
  readonly trackedSetChanged: boolean;
  readonly resolvedUnmerged: boolean;
}

type PathComparator = (a: IndexEntry, b: IndexEntry) => number;

const sortedCopy = (
  entries: ReadonlyArray<IndexEntry>,
  comparePath: PathComparator,
): ReadonlyArray<IndexEntry> =>
  [...entries].sort((a, b) => comparePath(a, b) || a.flags.stage - b.flags.stage);

const differs = (a: IndexEntry, b: IndexEntry): boolean => a.id !== b.id || a.mode !== b.mode;

const collectChangedPaths = (
  before: ReadonlyArray<IndexEntry>,
  after: ReadonlyArray<IndexEntry>,
  comparePath: PathComparator,
): ReadonlyArray<FilePath> => {
  const changed: FilePath[] = [];
  const mark = (entry: IndexEntry): void => {
    if (changed[changed.length - 1] !== entry.path) changed.push(entry.path);
  };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] as IndexEntry;
    const right = after[j] as IndexEntry;
    const order = comparePath(left, right) || left.flags.stage - right.flags.stage;
    if (order < 0) {
      mark(left);
      i++;
    } else if (order > 0) {
      mark(right);
      j++;
    } else {
      if (differs(left, right)) mark(left);
      i++;
      j++;
    }
  }
  for (; i < before.length; i++) mark(before[i] as IndexEntry);
  for (; j < after.length; j++) mark(after[j] as IndexEntry);
  return changed;
};

const skipSamePath = (
  entries: ReadonlyArray<IndexEntry>,
  from: number,
  comparePath: PathComparator,
): number => {
  let next = from + 1;
  while (
    next < entries.length &&
    comparePath(entries[from] as IndexEntry, entries[next] as IndexEntry) === 0
  )
    next++;
  return next;
};

const pathSetsDiffer = (
  before: ReadonlyArray<IndexEntry>,
  after: ReadonlyArray<IndexEntry>,
  comparePath: PathComparator,
): boolean => {
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (comparePath(before[i] as IndexEntry, after[j] as IndexEntry) !== 0) return true;
    i = skipSamePath(before, i, comparePath);
    j = skipSamePath(after, j, comparePath);
  }
  return i < before.length || j < after.length;
};

const hasResolvedUnmerged = (
  before: ReadonlyArray<IndexEntry>,
  after: ReadonlyArray<IndexEntry>,
  comparePath: PathComparator,
): boolean => {
  let j = 0;
  for (const entry of before) {
    if (entry.flags.stage === 0) continue;
    while (j < after.length && comparePath(after[j] as IndexEntry, entry) < 0) j++;
    let k = j;
    let unmergedAfter = false;
    for (; k < after.length && comparePath(after[k] as IndexEntry, entry) === 0; k++) {
      if ((after[k] as IndexEntry).flags.stage !== 0) unmergedAfter = true;
    }
    if (k > j && !unmergedAfter) return true;
  }
  return false;
};

export const diffIndexEntries = (
  before: ReadonlyArray<IndexEntry>,
  after: ReadonlyArray<IndexEntry>,
): IndexChange => {
  const comparePath = pathComparatorFor([...before, ...after]);
  const sortedBefore = sortedCopy(before, comparePath);
  const sortedAfter = sortedCopy(after, comparePath);
  return {
    changedPaths: collectChangedPaths(sortedBefore, sortedAfter, comparePath),
    trackedSetChanged: pathSetsDiffer(sortedBefore, sortedAfter, comparePath),
    resolvedUnmerged: hasResolvedUnmerged(sortedBefore, sortedAfter, comparePath),
  };
};

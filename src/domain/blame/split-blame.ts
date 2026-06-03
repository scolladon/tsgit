import type { LineDiff } from '../diff/line-diff.js';
import type { BlameEntry } from './types.js';

export interface SplitResult {
  /** Entries unchanged from the parent — re-based onto the parent's line numbering. */
  readonly passed: ReadonlyArray<BlameEntry>;
  /** Entries differing from the parent — still suspected at the child. */
  readonly kept: ReadonlyArray<BlameEntry>;
}

/**
 * Partition blame entries (suspected at a child blob) against the line diff of
 * `parent → child` (`diffLines(parentBlob, childBlob)`: `ours` = parent, `theirs`
 * = child). Lines in a `common` hunk are unchanged from the parent and `pass`
 * down with their `sourceStart` shifted to the parent's numbering; lines the
 * child added (`theirs-only`) are `kept` at the child. `finalStart` (the line's
 * position in the queried file) is invariant on both sides.
 */
export const splitAgainstParent = (
  entries: ReadonlyArray<BlameEntry>,
  lineDiff: LineDiff,
): SplitResult => {
  const childToParent = buildChildToParent(lineDiff);
  const passed: BlameEntry[] = [];
  const kept: BlameEntry[] = [];
  for (const entry of entries) {
    splitEntry(entry, childToParent, passed, kept);
  }
  return { passed, kept };
};

/** Map each child line index to its parent line index, across all `common` hunks. */
const buildChildToParent = (lineDiff: LineDiff): ReadonlyMap<number, number> => {
  const map = new Map<number, number>();
  for (const hunk of lineDiff.hunks) {
    if (hunk.kind !== 'common') continue;
    const count = hunk.theirsEnd - hunk.theirsStart;
    for (let i = 0; i < count; i += 1) {
      map.set(hunk.theirsStart + i, hunk.oursStart + i);
    }
  }
  return map;
};

/** Walk one entry's child range, emitting maximal passed / kept sub-runs. */
const splitEntry = (
  entry: BlameEntry,
  childToParent: ReadonlyMap<number, number>,
  passed: BlameEntry[],
  kept: BlameEntry[],
): void => {
  const end = entry.sourceStart + entry.count;
  let i = entry.sourceStart;
  while (i < end) {
    const finalStart = entry.finalStart + (i - entry.sourceStart);
    const parent = childToParent.get(i);
    if (parent === undefined) {
      let j = i + 1;
      while (j < end && !childToParent.has(j)) j += 1;
      kept.push({ finalStart, count: j - i, sourceStart: i });
      i = j;
    } else {
      let j = i + 1;
      let expectedParent = parent + 1;
      while (j < end && childToParent.get(j) === expectedParent) {
        j += 1;
        expectedParent += 1;
      }
      passed.push({ finalStart, count: j - i, sourceStart: parent });
      i = j;
    }
  }
};

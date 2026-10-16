import type { FlatTreeEntry } from '../diff/flat-tree.js';
import type { FilePath } from '../objects/index.js';

export type MergeSide = 'our' | 'their';

/** A path's base, ours and theirs entries, in that order. */
export type PathEntries = readonly [
  FlatTreeEntry | undefined,
  FlatTreeEntry | undefined,
  FlatTreeEntry | undefined,
];

/** For each side, the directories the other side alone brings: a file that side holds there is in the way. */
export type DirectoryBlockers = Readonly<Record<MergeSide, ReadonlySet<string>>>;

function survives(base: FlatTreeEntry | undefined, present: FlatTreeEntry): boolean {
  return base === undefined || base.id !== present.id || base.mode !== present.mode;
}

function addAncestors(directories: Set<string>, path: FilePath): void {
  // Stryker disable next-line StringLiteral: equivalent — indexOf('') is 0, so the mutant only adds '' before the same ancestors, and the set is only queried with has() for tree paths, which are never empty
  let slash = path.indexOf('/');
  while (slash !== -1) {
    directories.add(path.slice(0, slash));
    slash = path.indexOf('/', slash + 1);
  }
}

function isKept([base, our, their]: PathEntries): boolean {
  if (our !== undefined && their !== undefined) return true;
  const present = our ?? their;
  return present !== undefined && survives(base, present);
}

/**
 * A path the merge keeps puts a directory where either side may hold a file.
 * A side never holds a file above its own paths, except where a rename carried
 * the other side's path under it; a path the merge deletes leaves no directory.
 */
export function directoryBlockers(
  rows: ReadonlyArray<readonly [FilePath, PathEntries]>,
): DirectoryBlockers {
  const blockers = { our: new Set<string>(), their: new Set<string>() };
  for (const [path, entries] of rows) {
    if (!isKept(entries)) continue;
    addAncestors(blockers.our, path);
    addAncestors(blockers.their, path);
  }
  return blockers;
}

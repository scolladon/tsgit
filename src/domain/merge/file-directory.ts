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
  let slash = path.indexOf('/');
  while (slash !== -1) {
    directories.add(path.slice(0, slash));
    slash = path.indexOf('/', slash + 1);
  }
}

/**
 * Only a path one side added or changed can put a directory where the other
 * side holds a file; a path the merge deletes leaves no directory behind.
 */
export function directoryBlockers(
  rows: ReadonlyArray<readonly [FilePath, PathEntries]>,
): DirectoryBlockers {
  const blockers = { our: new Set<string>(), their: new Set<string>() };
  for (const [path, [base, our, their]] of rows) {
    if (our !== undefined && their === undefined && survives(base, our)) {
      addAncestors(blockers.their, path);
    }
    if (their !== undefined && our === undefined && survives(base, their)) {
      addAncestors(blockers.our, path);
    }
  }
  return blockers;
}

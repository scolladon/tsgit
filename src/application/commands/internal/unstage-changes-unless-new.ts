import { type IndexEntry, STAGE0_FLAGS } from '../../../domain/git-index/index.js';
import { pathComparatorFor } from '../../../domain/git-index/index-writer.js';
import type { FilePath } from '../../../domain/objects/index.js';

const PATH_SEPARATOR = '/';

const zeroStat = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  uid: 0,
  gid: 0,
  fileSize: 0,
  flags: STAGE0_FLAGS,
});

const byPath = (entries: ReadonlyArray<IndexEntry>): Map<FilePath, IndexEntry> =>
  new Map(entries.filter((e) => e.flags.stage === 0).map((e) => [e.path, e]));

const sameContent = (a: IndexEntry, b: IndexEntry): boolean => a.id === b.id && a.mode === b.mode;

const ancestorDirs = (path: string): string[] => {
  const dirs: string[] = [];
  for (let at = path.indexOf(PATH_SEPARATOR); at !== -1; at = path.indexOf(PATH_SEPARATOR, at + 1))
    dirs.push(path.slice(0, at));
  return dirs;
};

/** Paths a restored entry may not take: a kept new file, or a directory a kept new path lives in. */
const occupiedBy = (kept: ReadonlyArray<IndexEntry>): ((path: FilePath) => boolean) => {
  const files = new Set<string>(kept.map((e) => e.path));
  const dirs = new Set<string>(kept.flatMap((e) => ancestorDirs(e.path)));
  return (path) => dirs.has(path) || ancestorDirs(path).some((dir) => files.has(dir));
};

/**
 * git's `unstage_changes_unless_new`: after a clean `stash apply` every path the
 * merge changed or deleted goes back to its pre-apply entry (zero stat, as
 * `make_cache_entry` builds it), while a path new to the index stays staged.
 * A restored entry that file/directory-collides with a kept new path is dropped,
 * as git's refused `add_index_entry` does.
 */
export const unstageChangesUnlessNew = (
  merged: ReadonlyArray<IndexEntry>,
  before: ReadonlyArray<IndexEntry>,
): IndexEntry[] => {
  const previous = byPath(before);
  const current = byPath(merged);
  const added = [...current.values()].filter((e) => !previous.has(e.path));
  const collides = occupiedBy(added);
  const entries = [...added];
  for (const [path, old] of previous) {
    const now = current.get(path);
    if (now !== undefined && sameContent(now, old)) entries.push(now);
    else if (!collides(path)) entries.push(zeroStat(old));
  }
  entries.sort(pathComparatorFor(entries));
  return entries;
};

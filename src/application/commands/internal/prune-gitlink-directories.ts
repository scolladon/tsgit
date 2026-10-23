import type { IndexEntry } from '../../../domain/git-index/index.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';
import type { IgnorePredicate } from './add-ignore.js';

/**
 * The index's word is authoritative for a gitlink: its directory is never
 * walked into, whatever `.git` it holds (the walk itself stays index-unaware
 * and does not follow a `.git` symlink). Prunes before delegating, so a
 * gitlink never reaches the wrapped predicate's ignored-path bookkeeping.
 */
export const pruneGitlinkDirectories = (
  ignore: IgnorePredicate,
  entries: Iterable<IndexEntry>,
): IgnorePredicate => {
  const gitlinks = new Set<FilePath>();
  for (const { mode, path, flags } of entries) {
    if (mode === FILE_MODE.GITLINK && flags.stage === 0) gitlinks.add(path);
  }
  return (path, isDirectory) => (isDirectory && gitlinks.has(path)) || ignore(path, isDirectory);
};

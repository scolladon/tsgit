/**
 * Construct a stage-0 `IndexEntry` with zeroed stat fields from just
 * `(path, id, mode)`. Used by code that synthesises index entries it did not
 * `lstat` (merged trees, stash trees) — the zeroed stat forces `status` onto
 * its content-hash path, which is correct for an entry whose on-disk stat is
 * unknown.
 */
import { type IndexEntry, STAGE0_FLAGS, type StatData } from '../../../domain/git-index/index.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';

export const zeroStat = (mode: FileMode): StatData => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
});

export const stage0Entry = (path: FilePath, id: ObjectId, mode: FileMode): IndexEntry => ({
  ...zeroStat(mode),
  id,
  flags: STAGE0_FLAGS,
  path,
});

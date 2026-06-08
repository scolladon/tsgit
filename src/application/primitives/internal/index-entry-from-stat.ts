import { type IndexEntry, STAGE0_FLAGS } from '../../../domain/git-index/index.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { FileStat } from '../../../ports/file-system.js';

/**
 * Build a freshly-staged, stage-0 `IndexEntry` from an `lstat` result plus the
 * staged `mode`/`id`/`path`. The stat-cache fields (ctime/mtime/dev/ino/uid/gid/
 * size) are copied so the next `status` can take the fast `isStatClean` path.
 * Shared by `add` (blob staging) and `submodule add` (gitlink + `.gitmodules`
 * staging).
 */
export const indexEntryFromStat = (
  stat: FileStat,
  mode: FileMode,
  id: ObjectId,
  path: FilePath,
): IndexEntry => ({
  ctimeSeconds: Math.floor(stat.ctimeMs / 1000),
  ctimeNanoseconds: 0,
  mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
  mtimeNanoseconds: 0,
  dev: stat.dev,
  ino: stat.ino,
  mode,
  uid: stat.uid,
  gid: stat.gid,
  fileSize: stat.size,
  id,
  flags: STAGE0_FLAGS,
  path,
});

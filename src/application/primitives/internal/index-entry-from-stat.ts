import { type IndexEntry, STAGE0_FLAGS } from '../../../domain/git-index/index.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { FileStat } from '../../../ports/file-system.js';

const NS_PER_SECOND = 1_000_000_000n;

/**
 * Sub-second remainder of a nanosecond-precision timestamp, or 0 when the
 * platform doesn't surface ns precision.
 */
const nanosecondsOf = (ns: bigint | undefined): number =>
  ns === undefined ? 0 : Number(ns % NS_PER_SECOND);

/**
 * The entry with its stat-cache fields (ctime/mtime/dev/ino/uid/gid/size)
 * replaced by those of `stat`; identity (id, mode, flags, path) is kept.
 */
export const withStatData = (entry: IndexEntry, stat: FileStat): IndexEntry => ({
  ...entry,
  ctimeSeconds: Math.floor(stat.ctimeMs / 1000),
  ctimeNanoseconds: nanosecondsOf(stat.ctimeNs),
  mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
  mtimeNanoseconds: nanosecondsOf(stat.mtimeNs),
  dev: stat.dev,
  ino: stat.ino,
  uid: stat.uid,
  gid: stat.gid,
  fileSize: stat.size,
});

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
): IndexEntry =>
  withStatData(
    {
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
      id,
      flags: STAGE0_FLAGS,
      path,
    },
    stat,
  );

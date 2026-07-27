import type { IndexEntry } from '../../../domain/git-index/index-entry.js';
import type { FileStat } from '../../../ports/file-system.js';

/**
 * The `.git/index` file's own mtime (sec + ns), as observed by `readIndex`.
 * Threaded into {@link isEntryStatClean} as the racy-clean guard's reference
 * point.
 */
export interface IndexMtime {
  readonly seconds: number;
  readonly nanoseconds: number;
}

const NS_PER_SECOND = 1_000_000_000n;

/** Truncate to the index's on-disk 32-bit field width (`ce_stat_data`). */
const truncate32 = (n: number): number => n >>> 0;

/**
 * An entry's recorded mtime is racy when it is not provably older than the
 * index file's own mtime — the same-second (or same-nanosecond-tick) window
 * in which a subsequent edit could land without visibly changing the stat.
 * Mirrors git's `is_racy_timestamp`: `indexMtime <= entry mtime`.
 */
const isRacy = (entry: IndexEntry, indexMtime: IndexMtime): boolean => {
  if (entry.mtimeSeconds > indexMtime.seconds) return true;
  if (entry.mtimeSeconds < indexMtime.seconds) return false;
  return entry.mtimeNanoseconds >= indexMtime.nanoseconds;
};

const matchesMtime = (entry: IndexEntry, stat: FileStat): boolean => {
  if (entry.mtimeSeconds !== Math.floor(stat.mtimeMs / 1000)) return false;
  if (stat.mtimeNs === undefined) return true;
  return entry.mtimeNanoseconds === Number(stat.mtimeNs % NS_PER_SECOND);
};

const matchesCtime = (entry: IndexEntry, stat: FileStat): boolean => {
  if (entry.ctimeSeconds !== Math.floor(stat.ctimeMs / 1000)) return false;
  if (stat.ctimeNs === undefined) return true;
  return entry.ctimeNanoseconds === Number(stat.ctimeNs % NS_PER_SECOND);
};

/**
 * `ce_match_stat_basic`'s content-stat field set: mtime, ctime, uid, gid,
 * ino, size. `dev` is deliberately excluded (git's default build has
 * `USE_STDEV` off); `mode` is deliberately excluded (the caller derives the
 * `unchanged`/`mode-changed` verdict from the mode comparison itself, so a
 * pure exec-bit change never forces a re-hash).
 */
const matchesContentStat = (entry: IndexEntry, stat: FileStat): boolean =>
  matchesMtime(entry, stat) &&
  matchesCtime(entry, stat) &&
  entry.uid === stat.uid &&
  entry.gid === stat.gid &&
  truncate32(entry.ino) === truncate32(stat.ino) &&
  truncate32(entry.fileSize) === truncate32(stat.size);

/**
 * `ie_match_stat`-faithful stat-cache short-circuit: is `entry` provably
 * unchanged against the current working-tree `stat` without reading or
 * hashing the file's content? An assume-valid entry (`CE_VALID`) is
 * unconditionally clean; a racy entry (recorded mtime not provably older
 * than the index file's own mtime) always defers to read+hash; otherwise
 * the content-stat field set must match exactly.
 */
export const isEntryStatClean = (
  entry: IndexEntry,
  stat: FileStat,
  indexMtime: IndexMtime,
): boolean => {
  if (entry.flags.assumeValid) return true;
  if (isRacy(entry, indexMtime)) return false;
  return matchesContentStat(entry, stat);
};

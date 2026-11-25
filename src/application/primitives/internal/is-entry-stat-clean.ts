import { errorDataCode } from '../../../domain/error-data-code.js';
import type { IndexEntry } from '../../../domain/git-index/index-entry.js';
import type { StatCheck } from '../../../domain/git-index/stat-check.js';
import {
  type ExecutableBitTrust,
  FILE_MODE,
  indexModeFromStat,
} from '../../../domain/objects/file-mode.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../domain/objects/hash-config.js';
import { emptyBlobOid, type ObjectId } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import { lstatIfPresent } from './fs-probes.js';

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
 * Git's `is_racy_timestamp` as built without nanosecond stat support: an entry modified in
 * the index file's own second or later is not provably older than the index, so an edit
 * could have landed after it without visibly changing the stat. A gitlink is never racy.
 */
export const isRacyTimestamp = (entry: IndexEntry, indexMtime: IndexMtime): boolean =>
  entry.mode !== FILE_MODE.GITLINK && indexMtime.seconds <= entry.mtimeSeconds;

/**
 * Git's `has_racy_timestamp`: the index is racy when any entry (every stage counts) is
 * racy against the index file's own mtime.
 */
export const hasRacyTimestamp = (
  entries: ReadonlyArray<IndexEntry>,
  indexMtime: IndexMtime,
): boolean =>
  indexMtime.seconds !== 0 && entries.some((entry) => isRacyTimestamp(entry, indexMtime));

const MS_PER_SECOND = 1000;

const wholeSecond = (ms: number): number => Math.floor(ms / MS_PER_SECOND);

const matchesMtime = (entry: IndexEntry, stat: FileStat): boolean => {
  if (entry.mtimeSeconds !== wholeSecond(stat.mtimeMs)) return false;
  if (stat.mtimeNs === undefined) return true;
  return entry.mtimeNanoseconds === Number(stat.mtimeNs % NS_PER_SECOND);
};

const matchesCtime = (entry: IndexEntry, stat: FileStat): boolean => {
  if (entry.ctimeSeconds !== wholeSecond(stat.ctimeMs)) return false;
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
export const matchesContentStat = (entry: IndexEntry, stat: FileStat): boolean =>
  matchesMtime(entry, stat) &&
  matchesCtime(entry, stat) &&
  entry.uid === stat.uid &&
  entry.gid === stat.gid &&
  truncate32(entry.ino) === truncate32(stat.ino) &&
  truncate32(entry.fileSize) === truncate32(stat.size);

const EMPTY_BLOB_OIDS: ReadonlySet<ObjectId> = new Set([
  emptyBlobOid(SHA1_CONFIG),
  emptyBlobOid(SHA256_CONFIG),
]);

const isEmptyBlobOid = (id: ObjectId): boolean => EMPTY_BLOB_OIDS.has(id);

/** Size 0 recorded for a non-empty blob: git's marker of a racily clean entry it smudged. */
const isRacilySmudged = (entry: IndexEntry): boolean =>
  entry.fileSize === 0 && !isEmptyBlobOid(entry.id);

const ownerAndInodeMatch = (entry: IndexEntry, stat: FileStat): boolean =>
  entry.uid === stat.uid &&
  entry.gid === stat.gid &&
  truncate32(entry.ino) === truncate32(stat.ino);

/**
 * git's `match_stat_data` as built without nanosecond stat support — whole seconds, and only
 * the fields `check` lets count — plus the racily-smudged test of `ie_match_stat`. Same-second
 * drift is no drift here: the racy guard settles that by content.
 */
export const matchesStatData = (entry: IndexEntry, stat: FileStat, check: StatCheck): boolean =>
  entry.mtimeSeconds === wholeSecond(stat.mtimeMs) &&
  (!check.ctime || entry.ctimeSeconds === wholeSecond(stat.ctimeMs)) &&
  (!check.ownerAndInode || ownerAndInodeMatch(entry, stat)) &&
  truncate32(entry.fileSize) === truncate32(stat.size) &&
  !isRacilySmudged(entry);

/**
 * `ie_match_stat`-faithful stat-cache short-circuit: is `entry` provably
 * unchanged against the current working-tree `stat` without reading or
 * hashing the file's content? An assume-valid entry (`CE_VALID`) is
 * unconditionally clean; a racy entry (recorded mtime second not before the
 * index file's own) always defers to read+hash; otherwise the stat data must
 * match in whole seconds, on the fields `check` lets count.
 */
export const isEntryStatClean = (
  entry: IndexEntry,
  stat: FileStat,
  indexMtime: IndexMtime,
  check: StatCheck,
): boolean => {
  if (entry.flags.assumeValid) return true;
  if (isRacyTimestamp(entry, indexMtime)) return false;
  return matchesStatData(entry, stat, check);
};

// A tracked path's index entry with the mtime of the index it came from (the racy-guard reference).
export interface CachedStat {
  readonly entry: IndexEntry;
  readonly indexMtime: IndexMtime | undefined;
  readonly executableBit: ExecutableBitTrust;
  readonly statCheck: StatCheck;
}

/** A tracked path's cached stat before the stat policies are attached. */
export type TrackedStat = Omit<CachedStat, 'executableBit' | 'statCheck'>;

/** Decides a racy, stat-matching entry by its content. */
export type RacyContentCheck = (
  entry: IndexEntry,
  absPath: string,
  stat: FileStat,
) => Promise<boolean>;

export const UNREACHABLE = Symbol('unreachable');

// git's lstat of the whole path: ENOENT reads as absent, ENOTDIR as unreachable.
export const lstatBeyondLink = async (
  ctx: Context,
  absPath: string,
): Promise<FileStat | undefined | typeof UNREACHABLE> => {
  try {
    return await lstatIfPresent(ctx.fs, absPath);
  } catch (err) {
    if (errorDataCode(err) === 'NOT_A_DIRECTORY') return UNREACHABLE;
    throw err;
  }
};

// git's `ie_match_stat`: the cached stat fields settle it, and a racy entry (its mtime not
// older than the index file's) is settled by the content instead.
export const matchesCachedStat = async (
  { entry, indexMtime, executableBit }: CachedStat,
  absPath: string,
  stat: FileStat,
  contentMatches: RacyContentCheck,
): Promise<boolean> => {
  if (
    indexModeFromStat(stat, entry.mode, executableBit) !== entry.mode ||
    !matchesContentStat(entry, stat)
  )
    return false;
  if (indexMtime !== undefined && !isRacyTimestamp(entry, indexMtime)) return true;
  return contentMatches(entry, absPath, stat);
};

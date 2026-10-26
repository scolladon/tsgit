import { errorDataCode } from '../../../domain/error-data-code.js';
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index-entry.js';
import { type IndexPathKey, indexPathKey } from '../../../domain/git-index/index-path-key.js';
import { deriveWorkingMode, FILE_MODE } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { compareAndRefresh, scopeOf } from '../compare-working-tree-entry.js';
import { indexPath } from '../path-layout.js';
import { readIndexAt } from '../read-index.js';
import { lstatIfReachable } from './fs-probes.js';
import { type IndexMtime, isRacy, matchesContentStat } from './is-entry-stat-clean.js';
import { joinPath } from './join-working-tree-path.js';
import { buildCheckinAttributeProvider } from './read-gitattributes.js';
import { createLeadingPathScanner } from './symlinked-leading-path.js';

const CORRUPT_INDEX_CODE_PREFIX = 'INVALID_INDEX_';
/** Whether the caller already found `path` unchanged (git's `CE_UPTODATE`). */
export type IsVerified = (path: FilePath) => boolean;

export const NOTHING_VERIFIED: IsVerified = () => false;

/** `is_racy_timestamp`: a gitlink is never racy. */
const isRacyTimestamp = (entry: IndexEntry, indexMtime: IndexMtime): boolean =>
  entry.mode !== FILE_MODE.GITLINK && isRacy(entry, indexMtime);

/** Everything `ce_stat_data` and the object name hold, as one comparable value. */
const statDataKey = (entry: IndexEntry): string =>
  [
    entry.id,
    entry.mode,
    entry.fileSize,
    entry.mtimeSeconds,
    entry.mtimeNanoseconds,
    entry.ctimeSeconds,
    entry.ctimeNanoseconds,
    entry.ino,
    entry.dev,
    entry.uid,
    entry.gid,
  ].join();

/**
 * The index on disk as the lock's commit finds it. A missing or corrupt index
 * carries no stat data or extensions over; any other refusal propagates.
 */
export const readPreviousIndex = async (ctx: Context): Promise<GitIndex | undefined> => {
  const stat = await lstatIfReachable(ctx.fs, indexPath(ctx.layout.gitDir));
  if (stat === undefined) return undefined;
  try {
    return await readIndexAt(ctx, stat);
  } catch (err) {
    if (errorDataCode(err)?.startsWith(CORRUPT_INDEX_CODE_PREFIX) === true) return undefined;
    throw err;
  }
};

/** Stands in for git's `!ce_uptodate`: the entry is the index's own, unchanged since read. */
const carriedOver = (
  previous: GitIndex,
  racy: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  const racyByPath = new Map<IndexPathKey, IndexEntry>(
    racy.map((entry) => [indexPathKey(entry), entry]),
  );
  const unchanged: IndexEntry[] = [];
  for (const entry of previous.entries) {
    const candidate = racyByPath.get(indexPathKey(entry));
    if (candidate !== undefined && statDataKey(candidate) === statDataKey(entry)) {
      unchanged.push(candidate);
    }
  }
  return unchanged;
};

/** The entries `keep` approves, each probed concurrently. */
const filterConcurrently = async (
  entries: ReadonlyArray<IndexEntry>,
  keep: (entry: IndexEntry) => Promise<boolean>,
): Promise<ReadonlyArray<IndexEntry>> => {
  const kept = await Promise.all(entries.map(keep));
  return entries.filter((_, i) => kept[i]);
};

/** `ce_match_stat_basic` found no change: same kind, mode and content stat. */
const statStillMatches = async (
  ctx: Context,
  workDir: string,
  entry: IndexEntry,
): Promise<boolean> => {
  const stat = await lstatIfReachable(ctx.fs, joinPath(workDir, entry.path));
  return (
    stat !== undefined && deriveWorkingMode(stat) === entry.mode && matchesContentStat(entry, stat)
  );
};

/** The racy carried-over entries whose stat still matches their working file. */
const racilyClean = async (
  ctx: Context,
  workDir: string,
  entries: ReadonlyArray<IndexEntry>,
  previous: GitIndex,
  indexMtime: IndexMtime,
  verified: IsVerified,
): Promise<ReadonlyArray<IndexEntry>> => {
  const racy = entries.filter(
    (entry) => isRacyTimestamp(entry, indexMtime) && !verified(entry.path),
  );
  if (racy.length === 0) return [];
  return filterConcurrently(carriedOver(previous, racy), (entry) =>
    statStillMatches(ctx, workDir, entry),
  );
};

/**
 * git's `do_write_index` racy smudge (`ce_smudge_racily_clean_entry`): a
 * carried-over entry not older than the index as read, whose stat still
 * matches a working file of different content, is written with size 0 so
 * the next stat comparison cannot mistake it for clean. `verified` paths were
 * already found unchanged by the caller (git's `CE_UPTODATE`) and are not re-checked.
 */
export const smudgeRacilyClean = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  previous: GitIndex | undefined,
  verified: IsVerified = NOTHING_VERIFIED,
): Promise<ReadonlyArray<IndexEntry>> => {
  const workDir = ctx.layout.workDir;
  if (workDir === undefined || previous?.indexMtime === undefined) return entries;
  const clean = await racilyClean(ctx, workDir, entries, previous, previous.indexMtime, verified);
  if (clean.length === 0) return entries;
  const provider = await buildCheckinAttributeProvider(ctx);
  // One single-flight leading-path memo for the concurrent pass: a shared directory is lstat-ed once.
  const scope = scopeOf(provider, undefined, createLeadingPathScanner(ctx));
  const modified = await filterConcurrently(
    clean,
    async (entry) => (await compareAndRefresh(ctx, entry, scope)).delta.status === 'modified',
  );
  const smudged = new Set(modified);
  return entries.map((entry) => (smudged.has(entry) ? { ...entry, fileSize: 0 } : entry));
};

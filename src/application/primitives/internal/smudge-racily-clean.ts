import { errorDataCode } from '../../../domain/error-data-code.js';
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index-entry.js';
import type { StatCheck } from '../../../domain/git-index/stat-check.js';
import { type ExecutableBitTrust, indexModeFromStat } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import { compareAndRefresh, scopeOf } from '../compare-working-tree-entry.js';
import { indexPath } from '../path-layout.js';
import { readExecutableBitTrust } from '../read-executable-bit-trust.js';
import { readIndexAt } from '../read-index.js';
import { readStatCheck } from '../read-stat-check.js';
import { boundedMapFor } from './concurrency.js';
import { lstatIfReachable } from './fs-probes.js';
import { type IndexMtime, isRacyTimestamp, matchesStatData } from './is-entry-stat-clean.js';
import { joinPath } from './join-working-tree-path.js';
import { buildCheckinAttributeProvider } from './read-gitattributes.js';
import { createLeadingPathScanner } from './symlinked-leading-path.js';

const CORRUPT_INDEX_CODE_PREFIX = 'INVALID_INDEX_';
/** Whether the caller already found `path` unchanged (git's `CE_UPTODATE`). */
export type IsVerified = (path: FilePath) => boolean;

export const NOTHING_VERIFIED: IsVerified = () => false;

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

/**
 * Stands in for git's `!ce_uptodate`: the entry still carries stat data the index held when it
 * was read, at its own path or at the path a rename moved it from. Only the racy entries of
 * that index are keyed: a carried-over entry has its former self's mtime, so that one was racy
 * too, and a large index with a few racy entries costs a few keys.
 */
const carriedOver = (
  previous: GitIndex,
  racy: ReadonlyArray<IndexEntry>,
  indexMtime: IndexMtime,
): ReadonlyArray<IndexEntry> => {
  const racyAsRead = previous.entries.filter((entry) => isRacyTimestamp(entry, indexMtime));
  const asRead = new Set(racyAsRead.map(statDataKey));
  return racy.filter((entry) => asRead.has(statDataKey(entry)));
};

/**
 * The entries `keep` approves, probed through the I/O bound: after a checkout every entry can
 * share the index's second, and an unbounded fan-out then opens every tracked file at once.
 */
const filterConcurrently = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  keep: (entry: IndexEntry) => Promise<boolean>,
): Promise<ReadonlyArray<IndexEntry>> => {
  const kept = await boundedMapFor(ctx, 'ioBound', entries, keep);
  return entries.filter((_, i) => kept[i]);
};

/**
 * git's smudge returns on any `lstat` failure, not only an absent path: a stat that cannot be
 * taken proves nothing about the entry, and must not fail the index write.
 */
const statIfAny = (ctx: Context, absPath: string): Promise<FileStat | undefined> =>
  lstatIfReachable(ctx.fs, absPath).catch(() => undefined);

/** `ce_match_stat_basic` found no change: same kind, mode and content stat. */
const statStillMatches = async (
  ctx: Context,
  workDir: string,
  entry: IndexEntry,
  policy: Pick<RacilyClean, 'executableBit' | 'statCheck'>,
): Promise<boolean> => {
  const stat = await statIfAny(ctx, joinPath(workDir, entry.path));
  return (
    stat !== undefined &&
    indexModeFromStat(stat, entry.mode, policy.executableBit) === entry.mode &&
    matchesStatData(entry, stat, policy.statCheck)
  );
};

interface RacilyClean {
  readonly clean: ReadonlyArray<IndexEntry>;
  readonly executableBit: ExecutableBitTrust;
  readonly statCheck: StatCheck;
}

/** The racy carried-over entries whose stat still matches their working file. */
const racilyClean = async (
  ctx: Context,
  workDir: string,
  entries: ReadonlyArray<IndexEntry>,
  previous: GitIndex,
  indexMtime: IndexMtime,
  verified: IsVerified,
): Promise<RacilyClean | undefined> => {
  const racy = entries.filter(
    (entry) => isRacyTimestamp(entry, indexMtime) && !verified(entry.path),
  );
  if (racy.length === 0) return undefined;
  const policy = {
    executableBit: await readExecutableBitTrust(ctx),
    statCheck: await readStatCheck(ctx),
  };
  const clean = await filterConcurrently(ctx, carriedOver(previous, racy, indexMtime), (entry) =>
    statStillMatches(ctx, workDir, entry, policy),
  );
  return { clean, ...policy };
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
  const found = await racilyClean(ctx, workDir, entries, previous, previous.indexMtime, verified);
  if (found === undefined || found.clean.length === 0) return entries;
  const { clean, executableBit, statCheck } = found;
  const provider = await buildCheckinAttributeProvider(ctx);
  // One single-flight leading-path memo for the concurrent pass: a shared directory is lstat-ed once.
  const scope = {
    ...scopeOf(provider, undefined, createLeadingPathScanner(ctx)),
    executableBit,
    statCheck,
  };
  const modified = await filterConcurrently(
    ctx,
    clean,
    async (entry) => (await compareAndRefresh(ctx, entry, scope)).delta.status === 'modified',
  );
  const smudged = new Set(modified);
  return entries.map((entry) => (smudged.has(entry) ? { ...entry, fileSize: 0 } : entry));
};

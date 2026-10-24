import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { escapedPathOf } from '../../../domain/git-index/index-path-key.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { compareAndRefresh, type WorkingTreeDelta } from '../compare-working-tree-entry.js';
import { type CleanOrder, configuresFilterDriver, inIndexOrder } from './clean-order.js';
import { boundedMapFor } from './concurrency.js';
import { type AttributeProvider, buildCheckinAttributeProvider } from './read-gitattributes.js';
import type { IsVerified } from './smudge-racily-clean.js';
import { createLeadingPathScanner, type LeadingPathScanner } from './symlinked-leading-path.js';

/** The tracked pass: every tracked file's delta plus the entries whose stat data drifted. */
export interface TrackedScan {
  readonly workingMap: Map<FilePath, WorkingTreeDelta>;
  readonly refreshed: ReadonlyArray<IndexEntry>;
}

interface ScannedEntry {
  readonly path: FilePath;
  readonly delta: WorkingTreeDelta;
  readonly refreshed: IndexEntry | undefined;
}

/**
 * Working-tree pass: compare every stage-0 entry to its working file. A
 * skip-worktree entry is intentionally absent from disk (sparse), so it is not
 * compared. The provider enables clean-filter re-application so
 * smudged-then-unmodified files report unchanged. The optional `indexMtime`
 * (the `.git/index` file's own mtime) arms the stat-cache short-circuit in
 * `compareWorkingTreeDelta`. The comparisons fan out through the `ioBound`
 * bucket: each `lstat`+optional-hash is independent per path, and
 * `boundedMap`'s completion-order-independent result array is safe here
 * because every entry is keyed by its own unique path.
 */
const scanEntry = async (
  ctx: Context,
  entry: IndexEntry,
  provider: AttributeProvider,
  indexMtime: GitIndex['indexMtime'],
  filterDriversConfigured: boolean,
  scanner: LeadingPathScanner,
): Promise<ScannedEntry | undefined> => {
  if (entry.flags.skipWorktree) return undefined;
  const { delta, refreshed } = await compareAndRefresh(ctx, entry, {
    provider,
    ...(indexMtime !== undefined && { indexMtime }),
    filterDriversConfigured,
    scanner,
  });
  return { path: escapedPathOf(entry), delta, refreshed };
};

const trackedScanOf = (results: ReadonlyArray<ScannedEntry | undefined>): TrackedScan => {
  const workingMap = new Map<FilePath, WorkingTreeDelta>();
  const refreshed: IndexEntry[] = [];
  for (const result of results) {
    if (result === undefined) continue;
    workingMap.set(result.path, result.delta);
    if (result.refreshed !== undefined) refreshed.push(result.refreshed);
  }
  return { workingMap, refreshed };
};

const scanWorkingTree = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  onScanned: () => void,
  provider: AttributeProvider,
  indexMtime: GitIndex['indexMtime'],
): Promise<TrackedScan> => {
  const filterDriversConfigured = await configuresFilterDriver(ctx);
  const scanner = createLeadingPathScanner(ctx);
  const scan = (order?: CleanOrder) =>
    boundedMapFor(ctx, 'ioBound', stage0, async (entry) => {
      try {
        const scanned = await scanEntry(
          ctx,
          entry,
          provider,
          indexMtime,
          filterDriversConfigured,
          scanner,
        );
        onScanned();
        return scanned;
      } finally {
        order?.release(entry.path);
      }
    });
  // A clean driver hears the paths in index order, however the reads race;
  // with no driver configured no clean runs or refuses, and the scan needs no order.
  const results = filterDriversConfigured ? await inIndexOrder(ctx, stage0, scan) : await scan();
  return trackedScanOf(results);
};

/**
 * One `compareAndRefresh` per stage-0, non-skip-worktree entry through the
 * `ioBound` pool; clean drivers hear paths in index order. The check-in
 * attribute provider is built once per scan and is always present: a path whose
 * attributes resolve to the identity conversion costs one lookup.
 */
export const scanTrackedEntries = async (
  ctx: Context,
  index: GitIndex,
  stage0: ReadonlyArray<IndexEntry>,
  onScanned: () => void,
): Promise<TrackedScan> => {
  const provider = await buildCheckinAttributeProvider(ctx, index);
  return scanWorkingTree(ctx, stage0, onScanned, provider, index.indexMtime);
};

/** git's `CE_UPTODATE`: the scan found the path unchanged, by stat or by content. */
export const verifiedBy =
  (scan: TrackedScan): IsVerified =>
  (path) =>
    scan.workingMap.get(path)?.status === 'unchanged';

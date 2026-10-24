/**
 * Single source of truth for "is this index entry dirty in the working tree?".
 *
 * Compares the working file at `entry.path` against the entry's `(id, mode)`:
 * `absent` when no working file exists, `type-changed` when the file kind differs
 * (file↔symlink, git's `T`), `modified` when the content hash differs, `mode-changed`
 * when only the mode (exec bit) differs with identical content, else `unchanged`.
 * Content is hashed via the uncapped `serializeAndHash` core (never the size-capped
 * `hashBlob` write path), so a read-only comparison never throws on a large working
 * file. Symlink content is its target (`readlink`), not the followed file.
 *
 * A gitlink is compared as git's `ce_compare_gitlink` does: a directory is
 * `modified` when the commit checked out there differs from the entry's, and
 * `unchanged` when it matches or when no commit can be read; a file or symlink at
 * its path is `type-changed`. A matching gitlink is never refreshed.
 *
 * Consumed by `status` (which reads the richer `compareWorkingTreeDelta`) and by
 * `rm` / `stash` / clean-work-tree / apply-merge (the local-modification valve,
 * which read the `compareWorkingTreeEntry` enum projection).
 *
 * `compareWorkingTreeDelta` accepts an optional index-file mtime (the racy-guard
 * reference point for the `ie_match_stat` stat-cache short-circuit). Only
 * `status` supplies it; every other consumer keeps reading and hashing.
 */
import { isSameKind } from '../../domain/diff/mode-kind.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index-entry.js';
import { isLossy } from '../../domain/git-index/index-path-key.js';
import { deriveWorkingMode, FILE_MODE, type FileMode } from '../../domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import { convertToGit } from './internal/convert-blob.js';
import { probeGitlinkCheckout } from './internal/gitlink-head.js';
import { withStatData } from './internal/index-entry-from-stat.js';
import {
  type IndexMtime,
  isEntryStatClean,
  matchesContentStat,
} from './internal/is-entry-stat-clean.js';
import { joinPath } from './internal/join-working-tree-path.js';
import type { AttributeProvider } from './internal/read-gitattributes.js';
import { assertBigFileThresholdValid } from './internal/repo-settings-gate.js';
import { requireWorkTree } from './internal/repo-state.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';
import { readEolSettings, resolveConversion } from './resolve-conversion.js';
import { resolveFilterDriver, streamsThroughFilter } from './resolve-filter-driver.js';

export type WorkingTreeComparison =
  | 'absent'
  | 'unchanged'
  | 'modified'
  | 'type-changed'
  | 'mode-changed';

/**
 * A working-tree comparison plus the working file's mode (`mW`). `worktreeMode`
 * is what `git status --porcelain=v2` reports for the worktree side; it is
 * present whenever a working file exists and omitted only when the file is
 * `absent`. There is no working blob oid — the file need not be in the object
 * store, so git itself prints no `hW`.
 */
export interface WorkingTreeDelta {
  readonly status: WorkingTreeComparison;
  readonly worktreeMode?: FileMode;
}

/**
 * Whether a working-tree comparison represents a present-but-differing file —
 * the "modified variant" set git's local-modification valve refuses to clobber.
 * `absent` (gone) and `unchanged` (clean) are excluded; everything else
 * (`modified`, `type-changed`, `mode-changed`) is a local modification.
 */
export const isWorkingTreeModified = (comparison: WorkingTreeComparison): boolean =>
  comparison !== 'unchanged' && comparison !== 'absent';

const LINK_ENCODER = new TextEncoder();

/** No attribute sources: a caller without a provider still gets `core.autocrlf`. */
const EMPTY_PROVIDER: AttributeProvider = {
  sourcesForPath: async () => ({ sources: [], macros: new Map() }),
};

/**
 * The worktree bytes as git hashes them (`ce_compare_data`): through the path's
 * conversion, never writing an object and never raising a safecrlf refusal.
 * Conversion context — git validates every `[filter "<d>"].required` when it
 * actually clean-converts a path, and dies where `convert_to_git` does.
 * Symlinks are never converted — callers guard this.
 */
const convertedWorktreeBytes = async (
  ctx: Context,
  provider: AttributeProvider,
  entry: IndexEntry,
  raw: Uint8Array,
  filterDriversConfigured: boolean | undefined,
): Promise<Uint8Array> => {
  const settings = await readEolSettings(ctx);
  const conversion = await resolveConversion(ctx, provider, entry.path, settings, {
    eagerSectionValidation: true,
    ...(filterDriversConfigured !== undefined && { filterDriversConfigured }),
  });
  const converted = await convertToGit(ctx, {
    path: entry.path,
    bytes: raw,
    conversion,
    route: 'compare',
    settings,
    indexBlob: entry.id,
  });
  return converted.bytes;
};

/**
 * The verdicts reachable from the stat fields alone, before any content read.
 * `undefined` means the stat cannot settle it and the caller must hash.
 * Gitlinks never reach it: they are compared by the commit checked out at their path.
 */
const statOnlyVerdict = (
  entry: IndexEntry,
  stat: FileStat,
  worktreeMode: FileMode,
  indexMtime: IndexMtime | undefined,
): WorkingTreeDelta | undefined => {
  // A file↔symlink kind change is git's `T`, decided on mode alone — no hash
  // needed and the content is meaningless across kinds.
  if (!isSameKind(worktreeMode, entry.mode)) return { status: 'type-changed', worktreeMode };
  if (indexMtime === undefined) return undefined;
  // Stat-cache short-circuit (`ie_match_stat`): only armed when the caller
  // supplies the index file's own mtime (the racy-guard reference point).
  // Absent — every non-`status` consumer — the fast path never fires and
  // behaviour is exactly as before.
  if (isEntryStatClean(entry, stat, indexMtime)) {
    return { status: worktreeMode === entry.mode ? 'unchanged' : 'mode-changed', worktreeMode };
  }
  // Size settles the verdict without a read on the armed, non-racy path — as
  // git does: a working file whose size differs from the staged stat cannot
  // carry the staged raw bytes, and git reports it modified without running
  // the clean filter (measured: a size-changing edit under a malformed
  // `[filter *].required` leaves `git status` at exit 0).
  // A recorded size of 0 says the stat was never taken (read-tree, cacheinfo),
  // so git's `ie_modified` does not trust the size and compares content.
  if (!stat.isSymbolicLink && entry.fileSize !== 0 && entry.fileSize >>> 0 !== stat.size >>> 0) {
    return { status: 'modified', worktreeMode };
  }
  return undefined;
};

/** The path's driver, as git's `index_fd` weighs it: an attribute-engaged
 *  malformed driver refuses here, before any content read. */
const streamsThroughDriver = async (
  ctx: Context,
  provider: AttributeProvider | undefined,
  path: FilePath,
  filterDriversConfigured: boolean | undefined,
): Promise<boolean> =>
  filterDriversConfigured !== false &&
  provider !== undefined &&
  streamsThroughFilter(await resolveFilterDriver(ctx, provider, path));

/**
 * git's `index_fd` reads `core.bigFileThreshold` before hashing a regular
 * file it does not stream through a required filter. Only the
 * stat-cache-armed comparison reaches a hash where git does; an unarmed one
 * hashes files git's stat cache would have settled.
 */
const readThresholdBeforeHashing = async (
  ctx: Context,
  entry: IndexEntry,
  stat: FileStat,
  indexMtime: IndexMtime | undefined,
  provider: AttributeProvider | undefined,
  filterDriversConfigured: boolean | undefined,
): Promise<void> => {
  if (indexMtime === undefined || stat.isSymbolicLink) return;
  if (await streamsThroughDriver(ctx, provider, entry.path, filterDriversConfigured)) return;
  await assertBigFileThresholdValid(ctx);
};

/** What the comparison may consult beyond the entry itself. */
export interface ComparisonScope {
  readonly provider?: AttributeProvider;
  readonly indexMtime?: IndexMtime;
  /** `false` when the caller knows no `[filter "<d>"]` section exists, so no driver is looked up. */
  readonly filterDriversConfigured?: boolean;
  /** The scan's shared leading-path memo; a comparison outside a scan builds its own. */
  readonly scanner?: LeadingPathScanner;
}

/**
 * A comparison verdict plus, when the file is content-identical yet its stat
 * data drifted, the entry carrying the fresh stat data (git's refresh).
 */
export interface RefreshedComparison {
  readonly delta: WorkingTreeDelta;
  readonly refreshed?: IndexEntry;
}

const scopeOf = (provider?: AttributeProvider, indexMtime?: IndexMtime): ComparisonScope => ({
  ...(provider !== undefined && { provider }),
  ...(indexMtime !== undefined && { indexMtime }),
});

const compareContent = async (
  ctx: Context,
  entry: IndexEntry,
  absPath: string,
  stat: FileStat,
  worktreeMode: FileMode,
  scope: ComparisonScope,
): Promise<WorkingTreeDelta> => {
  await readThresholdBeforeHashing(
    ctx,
    entry,
    stat,
    scope.indexMtime,
    scope.provider,
    scope.filterDriversConfigured,
  );
  const raw = await readWorkingBytes(ctx, absPath, stat);
  // The file exists (lstat succeeded) but cannot be read — never report an
  // unverifiable file as `unchanged`; git's failed `index_path` reads changed.
  if (raw === undefined) return { status: 'modified', worktreeMode };
  // Symlink targets are always hashed raw.
  const content = stat.isSymbolicLink
    ? raw
    : await convertedWorktreeBytes(
        ctx,
        scope.provider ?? EMPTY_PROVIDER,
        entry,
        raw,
        scope.filterDriversConfigured,
      );
  const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content });
  // Content dominates: a changed blob is `modified` regardless of mode. Only a
  // same-blob mode difference (exec bit) is `mode-changed`.
  if (id !== entry.id) return { status: 'modified', worktreeMode };
  return { status: worktreeMode === entry.mode ? 'unchanged' : 'mode-changed', worktreeMode };
};

/**
 * The commit checked out at a gitlink, or `undefined` when git would find none:
 * no repository there, one it cannot read, or one without a resolvable HEAD.
 */
const checkedOutHead = async (ctx: Context, path: FilePath): Promise<ObjectId | undefined> => {
  const checkout = await probeGitlinkCheckout(ctx, path);
  if (checkout.kind !== 'repository') return undefined;
  try {
    return await checkout.head();
  } catch (err) {
    // git reads the HEAD it can and treats a repository it refuses to open as having none.
    if (err instanceof TsgitError) return undefined;
    throw err;
  }
};

const GITLINK_UNCHANGED: WorkingTreeDelta = {
  status: 'unchanged',
  worktreeMode: FILE_MODE.GITLINK,
};

const compareGitlink = async (
  ctx: Context,
  entry: IndexEntry,
  stat: FileStat,
  scope: ComparisonScope,
): Promise<WorkingTreeDelta> => {
  // git's `CE_VALID`: an assume-valid entry is trusted without a probe once the stat cache is armed.
  if (entry.flags.assumeValid && scope.indexMtime !== undefined) return GITLINK_UNCHANGED;
  if (!stat.isDirectory) return { status: 'type-changed', worktreeMode: deriveWorkingMode(stat) };
  const head = await checkedOutHead(ctx, entry.path);
  const status = head === undefined || head === entry.id ? 'unchanged' : 'modified';
  return { status, worktreeMode: FILE_MODE.GITLINK };
};

/**
 * Entries git's refresh leaves alone: unmerged, assume-valid, sparse, placeholder,
 * and a matching gitlink — `refresh_cache_ent` returns it without marking it up to
 * date or filling its stat data.
 */
const shouldRefresh = (entry: IndexEntry, stat: FileStat): boolean =>
  entry.mode !== FILE_MODE.GITLINK &&
  entry.flags.stage === 0 &&
  !entry.flags.assumeValid &&
  !entry.flags.skipWorktree &&
  !entry.flags.intentToAdd &&
  !matchesContentStat(entry, stat);

const compareFile = async (
  ctx: Context,
  entry: IndexEntry,
  absPath: string,
  stat: FileStat,
  scope: ComparisonScope,
): Promise<WorkingTreeDelta> => {
  const worktreeMode = deriveWorkingMode(stat);
  const settled = statOnlyVerdict(entry, stat, worktreeMode, scope.indexMtime);
  return settled ?? (await compareContent(ctx, entry, absPath, stat, worktreeMode, scope));
};

/**
 * git's `has_symlink_leading_path`: a path below a symlinked directory is deleted. A
 * leading directory that cannot be read reads `absent`, as its leaf `lstat` already does.
 */
const belowSymlinkedDirectory = (
  ctx: Context,
  entry: IndexEntry,
  scope: ComparisonScope,
): Promise<boolean> =>
  (scope.scanner ?? createLeadingPathScanner(ctx))
    .hasSymlinkedLeadingPath(entry.path)
    .catch(() => true);

/**
 * The comparison plus its refresh verdict, from the single `lstat` the
 * comparison already took — no second stat, no extra read.
 */
export const compareAndRefresh = async (
  ctx: Context,
  entry: IndexEntry,
  scope: ComparisonScope = {},
): Promise<RefreshedComparison> => {
  if (isLossy(entry)) return { delta: { status: 'absent' } };
  const absPath = joinPath(requireWorkTree(ctx, 'compareWorkingTreeEntry'), entry.path);
  if (await belowSymlinkedDirectory(ctx, entry, scope)) return { delta: { status: 'absent' } };
  const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
  if (stat === undefined) return { delta: { status: 'absent' } };
  const delta =
    entry.mode === FILE_MODE.GITLINK
      ? await compareGitlink(ctx, entry, stat, scope)
      : await compareFile(ctx, entry, absPath, stat, scope);
  if (delta.status === 'unchanged' && shouldRefresh(entry, stat)) {
    return { delta, refreshed: withStatData(entry, stat) };
  }
  return { delta };
};

export const compareWorkingTreeDelta = async (
  ctx: Context,
  entry: IndexEntry,
  provider?: AttributeProvider,
  indexMtime?: IndexMtime,
): Promise<WorkingTreeDelta> =>
  (await compareAndRefresh(ctx, entry, scopeOf(provider, indexMtime))).delta;

/** The working bytes git would hash — a symlink's target, a file's content —
 *  or `undefined` when the path cannot be read. */
const readWorkingBytes = async (
  ctx: Context,
  absPath: string,
  stat: FileStat,
): Promise<Uint8Array | undefined> => {
  try {
    return stat.isSymbolicLink
      ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath))
      : await ctx.fs.read(absPath);
  } catch {
    return undefined;
  }
};

/**
 * Enum projection over {@link compareWorkingTreeDelta} — the dirtiness verdict
 * without the mode. Consumed by the local-modification valve (`rm`, `stash`,
 * clean-work-tree, apply-merge) where only the status matters.
 */
export const compareWorkingTreeEntry = async (
  ctx: Context,
  entry: IndexEntry,
  provider?: AttributeProvider,
  indexMtime?: IndexMtime,
): Promise<WorkingTreeComparison> =>
  (await compareWorkingTreeDelta(ctx, entry, provider, indexMtime)).status;

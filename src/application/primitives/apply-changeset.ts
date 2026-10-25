/**
 * Apply a Changeset to the working tree + return new IndexEntry records.
 *
 * Lifecycle:
 *  1. Entry-name guard (always, even under `force`): every `add`/`update`
 *  target path is validated against git's index-write matrix before
 *  anything is written — mirrors git's `unpack_trees` building the new
 *  index in memory before `checkout_all` touches disk, so a hostile
 *  target-tree entry anywhere in the changeset leaves the working tree
 *  untouched rather than partially populated.
 *  2. Dirty-tree guard (unless `force`): hash any working-tree file that
 *  `update`/`delete` would touch and compare against the changeset's
 *  `previousId`. Untracked paths that `add` would clobber are also
 *  flagged. Collected paths surface as CHECKOUT_OVERWRITE_DIRTY.
 *  3. Apply each non-noop entry — `delete` then `add`/`update` per path,
 *  with per-file progress ticks.
 *  4. Build new stage-0 IndexEntry records from the post-write lstat.
 *
 * Atomicity: per-file for I/O failures (matches canonical git — no
 * cross-file rollback on e.g. a permission error mid-apply). The entry-name
 * guard is the one whole-changeset exception, matching git's own two-phase
 * split between index-build validation and the write phase.
 */
import { checkoutOverwriteDirty, type WouldOverwriteClasses } from '../../domain/commands/error.js';
import { comparePaths } from '../../domain/diff/index.js';
import type { EolSettings } from '../../domain/eol/crlf-action.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { isLossy } from '../../domain/git-index/index-path-key.js';
import { type IndexPathRules, NO_PARSER_OFFSET } from '../../domain/git-index/path-validator.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { Changeset, ChangesetEntry } from './compute-changeset.js';
import { readConfig } from './config-read.js';
import type { CheckoutMetadata } from './internal/apply-smudge-filter.js';
import { boundedMapFor, limiterFor } from './internal/concurrency.js';
import { convertToGit } from './internal/convert-blob.js';
import { removeEmptyDirectory } from './internal/empty-directories.js';
import { withFilterProcessPool } from './internal/filter-process-pool.js';
import { lstatIfReachable } from './internal/fs-probes.js';
import { indexEntryFromStat } from './internal/index-entry-from-stat.js';
import { indexPathRulesOf } from './internal/index-path-rules.js';
import { joinPath } from './internal/join-working-tree-path.js';
import { lazily } from './internal/lazily.js';
import {
  type ClashScope,
  classifyOccupant,
  createIgnoredProbe,
  holdsSurvivor,
  type IgnoredProbe,
  type OccupantClash,
  type OccupantVerdict,
  repoRelativePath,
} from './internal/occupant-clash.js';
import { pathIsOccupied } from './internal/path-occupied.js';
import {
  pruneEmptiedDirectories,
  type SurvivingDirectories,
  survivingDirectoriesOf,
} from './internal/prune-emptied-directories.js';
import {
  type AttributeDirection,
  type AttributeProvider,
  buildAttributeProvider,
  buildCheckinAttributeProvider,
} from './internal/read-gitattributes.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import {
  createLeadingPathScanner,
  type LeadingObstruction,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';
import { stage0Entry } from './internal/synthetic-index-entry.js';
import {
  createWorkingTreeWriter,
  type WorkingTreeWriter,
} from './internal/write-converted-entry.js';
import { everySourceLoadable } from './object-store.js';
import { readEolSettings, resolveConversion } from './resolve-conversion.js';

export type IgnoredOccupants = 'overwrite' | 'protect';
export type UntrackedOccupants = 'overwrite' | 'protect';
export type UnmergedPaths = 'hidden' | 'reset';

export interface ApplyChangesetOpts {
  readonly changeset: Changeset;
  readonly force: boolean;
  readonly workdir: string;
  /** The ref and commit the checkout moves to, told to a smudging process filter. */
  readonly checkoutMetadata?: CheckoutMetadata;
  /**
   * `protect` refuses an ignored occupant like an untracked one (git's `overwrite_ignore = 0`);
   * default `overwrite`.
   */
  readonly ignoredOccupants?: IgnoredOccupants;
  /**
   * `protect` refuses an untracked occupant even when forced (git's `reset_head` with
   * `UNPACK_RESET_PROTECT_UNTRACKED`); default `overwrite`.
   */
  readonly untrackedOccupants?: UntrackedOccupants;
  /**
   * `reset` treats an entry without a previous version (a conflicted path) as reset to the target,
   * with no up-to-date check; default `hidden`.
   */
  readonly unmergedPaths?: UnmergedPaths;
}

export interface ApplyChangesetResult {
  readonly writtenEntries: ReadonlyArray<IndexEntry>;
  readonly written: number;
  readonly deleted: number;
}

const CHECKOUT_OP = 'checkout:materialize';

const LINK_ENCODER = new TextEncoder();

/** What the dirty probe compares through: the check-in attributes and the eol settings. */
interface DirtyProbe {
  readonly provider: AttributeProvider;
  readonly settings: EolSettings;
}

const buildDirtyProbe = async (ctx: Context): Promise<DirtyProbe> => ({
  provider: await buildCheckinAttributeProvider(ctx),
  settings: await readEolSettings(ctx),
});

const readWorkingBytes = async (
  ctx: Context,
  absPath: string,
): Promise<{ readonly bytes: Uint8Array; readonly isSymlink: boolean } | undefined> => {
  try {
    const stat = await ctx.fs.lstat(absPath);
    if (stat.isSymbolicLink) {
      return { bytes: LINK_ENCODER.encode(await ctx.fs.readlink(absPath)), isSymlink: true };
    }
    return { bytes: await ctx.fs.read(absPath), isSymlink: false };
  } catch (err) {
    // FILE_NOT_FOUND on a `delete`/`update` target means the file is already
    // gone — treat as non-dirty so the apply step proceeds as a no-op.
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    // PERMISSION_DENIED and other read failures are NOT silently overwritten —
    // re-throw so the caller surfaces the underlying error instead of
    // clobbering an unreadable file.
    throw err;
  }
};

/**
 * The bytes git would hash for the path (`verify_uptodate` runs before the
 * checkout direction is set, so the check-in provider applies). Symlinks are
 * never converted.
 */
const comparableBytes = async (
  ctx: Context,
  probe: DirtyProbe,
  path: FilePath,
  working: { readonly bytes: Uint8Array; readonly isSymlink: boolean },
  expectedId: ObjectId,
): Promise<Uint8Array> => {
  if (working.isSymlink) return working.bytes;
  const conversion = await resolveConversion(ctx, probe.provider, path, probe.settings, {
    eagerSectionValidation: true,
  });
  const converted = await convertToGit(ctx, {
    path,
    bytes: working.bytes,
    conversion,
    route: 'compare',
    settings: probe.settings,
    indexBlob: expectedId,
  });
  return converted.bytes;
};

const blobMatches = async (
  ctx: Context,
  probe: DirtyProbe,
  path: FilePath,
  absPath: string,
  expectedId: string,
): Promise<boolean> => {
  const working = await readWorkingBytes(ctx, absPath);
  if (working === undefined) return true;
  const bytes = await comparableBytes(ctx, probe, path, working, expectedId as ObjectId);
  // Compute the loose-object content hash via the shared serialise+hash core
  // (the `blob <size>\0` header git stored), so this matches `writeObject` /
  // `hashBlob` byte-for-byte. Uncapped: a read-only dirty check never throws on
  // a large working file.
  const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content: bytes });
  return id === expectedId;
};

const isDirtyUnder = async (
  ctx: Context,
  probe: DirtyProbe,
  path: FilePath,
  absPath: string,
  expectedId: string,
): Promise<boolean> => {
  if (!(await pathIsOccupied(ctx, absPath))) return false;
  return !(await blobMatches(ctx, probe, path, absPath, expectedId));
};

export type WorkingTreeDirtyCheck = (absPath: string, expectedId: string) => Promise<boolean>;

/**
 * A dirty check over one lazily-built probe: the attribute provider and eol
 * settings are read once, on the first call, however many paths are checked.
 */
export const createWorkingTreeDirtyCheck = (ctx: Context): WorkingTreeDirtyCheck => {
  const probe = lazily(() => buildDirtyProbe(ctx));
  return async (absPath, expectedId) =>
    isDirtyUnder(ctx, await probe(), repoRelativePath(ctx, absPath), absPath, expectedId);
};

/**
 * `true` when a working-tree file exists at `absPath` but its content, taken
 * back through the path's check-in conversion, hashes differently from
 * `expectedId`. An absent file is not dirty. The one-shot form of
 * `createWorkingTreeDirtyCheck`, which `applySparseCheckout`'s narrowing
 * pre-scan shares.
 */
export const isWorkingTreeDirty = async (
  ctx: Context,
  absPath: string,
  expectedId: string,
): Promise<boolean> => createWorkingTreeDirtyCheck(ctx)(absPath, expectedId);

const verdictClash = (verdict: OccupantVerdict): OccupantClash | undefined =>
  verdict.kind === 'clash' ? verdict.clash : undefined;

// An unmerged path has no version to compare; only a directory still holding a file the
// changeset leaves behind stands in the way of the reset.
// A gitlink's directory is the submodule's own checkout, which git never reads: the
// removal leaves it standing, so it is no survivor.
const survivorClash = async (
  ctx: Context,
  { path, previousMode }: ChangesetEntry,
  scope: ClashScope,
): Promise<OccupantClash | undefined> => {
  if (previousMode === FILE_MODE.GITLINK) return undefined;
  const absPath = joinPath(scope.workdir, path);
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat?.isDirectory !== true) return undefined;
  return (await holdsSurvivor(ctx, absPath, scope)) ? { class: 'untracked', path } : undefined;
};

const evaluateChangedPath = async (
  ctx: Context,
  probe: () => Promise<DirtyProbe>,
  entry: ChangesetEntry,
  kind: 'update' | 'delete',
  scope: ClashScope,
  unmergedPaths: UnmergedPaths,
): Promise<OccupantClash | undefined> => {
  const { previousId } = entry;
  if (previousId === undefined) {
    return unmergedPaths === 'reset' ? survivorClash(ctx, entry, scope) : undefined;
  }
  // git's verify_uptodate returns early for a gitlink: the submodule's worktree is never compared.
  if (entry.previousMode === FILE_MODE.GITLINK) return undefined;
  const verdict = await classifyOccupant(ctx, { kind, path: entry.path }, scope);
  if (verdict.kind !== 'compare-content') return verdictClash(verdict);
  const matches = await blobMatches(
    ctx,
    await probe(),
    entry.path,
    joinPath(scope.workdir, entry.path),
    previousId,
  );
  return matches ? undefined : { class: 'local-changes', path: entry.path };
};

const evaluateDirtyPath = async (
  ctx: Context,
  probe: () => Promise<DirtyProbe>,
  entry: ChangesetEntry,
  scope: ClashScope,
  unmergedPaths: UnmergedPaths,
): Promise<OccupantClash | undefined> => {
  if (isLossy(entry)) return undefined;
  if (entry.kind === 'update' || entry.kind === 'delete') {
    return evaluateChangedPath(ctx, probe, entry, entry.kind, scope, unmergedPaths);
  }
  // Stryker disable next-line ConditionalExpression: equivalent — checkDirty only receives splitWaves' deletes and writes, which hold no noop, so an entry past the update/delete branch is always an add.
  if (entry.kind !== 'add') return undefined;
  return verdictClash(await classifyOccupant(ctx, { kind: 'add', path: entry.path }, scope));
};

type PathEvaluator = (
  ctx: Context,
  probe: () => Promise<DirtyProbe>,
  entry: ChangesetEntry,
  scope: ClashScope,
) => Promise<OccupantClash | undefined>;

const untrackedClashOf = (verdict: OccupantVerdict): OccupantClash | undefined => {
  const clash = verdictClash(verdict);
  return clash?.class === 'untracked' ? clash : undefined;
};

// The untracked-protecting pre-flight of a forced apply: what the writer would clobber
// without being told it may, and nothing about content.
const evaluateProtectedPath: PathEvaluator = async (ctx, _probe, entry, scope) => {
  if (isLossy(entry) || entry.kind === 'noop') return undefined;
  if (entry.kind === 'add') {
    return untrackedClashOf(await classifyOccupant(ctx, { kind: 'add', path: entry.path }, scope));
  }
  if (entry.previousId === undefined) return survivorClash(ctx, entry, scope);
  if (entry.kind === 'update') return undefined;
  return untrackedClashOf(await classifyOccupant(ctx, { kind: 'delete', path: entry.path }, scope));
};

const fullEvaluatorFor =
  (unmergedPaths: UnmergedPaths): PathEvaluator =>
  (ctx, probe, entry, scope) =>
    evaluateDirtyPath(ctx, probe, entry, scope, unmergedPaths);

// Which pre-flight the apply runs: the full one unforced, the untracked-only one when a
// forced apply protects untracked occupants, none when forced and free to overwrite.
const preflightOf = (
  force: boolean,
  untrackedOccupants: UntrackedOccupants,
  unmergedPaths: UnmergedPaths,
): PathEvaluator | undefined => {
  if (!force) return fullEvaluatorFor(unmergedPaths);
  return untrackedOccupants === 'protect' ? evaluateProtectedPath : undefined;
};

// The checkout path's tree->index boundary. Every `add`/`update` entry
// carries a path sourced from a target-tree walk (`walkTree` never
// validates entry names — that is git's `mktree` escape hatch), so each
// one is checked here before `applyAllEntries` writes anything.
// `delete`/`noop` entries are skipped: git does not verify a path it
// removes or leaves in place (unpack-trees verifies only entries it adds).
const validateChangesetEntry = (pathRules: IndexPathRules, entry: ChangesetEntry): void => {
  if (entry.kind !== 'add' && entry.kind !== 'update') return;
  pathRules.validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode, entry.pathBytes);
};

const validateChangesetPaths = (pathRules: IndexPathRules, changeset: Changeset): void => {
  for (const entry of changeset.entries) validateChangesetEntry(pathRules, entry);
};

// A lossy delete is never applied, and its decoded path may name a different, untracked file.
const deletedPaths = (
  workdir: string,
  entries: ReadonlyArray<ChangesetEntry>,
): ReadonlySet<string> =>
  new Set(
    entries.filter((e) => e.kind === 'delete' && !isLossy(e)).map((e) => joinPath(workdir, e.path)),
  );

const NEVER_IGNORED: IgnoredProbe = async () => false;

const checkDirty = async (
  ctx: Context,
  workdir: string,
  entries: ReadonlyArray<ChangesetEntry>,
  ignoredOccupants: IgnoredOccupants,
  evaluate: PathEvaluator,
): Promise<WouldOverwriteClasses> => {
  // Fanned out through the ioBound pool — pure reads, so collection order
  // is free: refusal arrays are sorted with `comparePaths` below regardless
  // of which entry's probe lands first. `entries` is the caller's
  // pre-split delete+write waves, never raw `changeset.entries` — a `noop`
  // entry needs no dirty probe at all, so skipping it here avoids both a
  // wasted pool slot and an oversized `boundedMap` allocation.
  const probe = lazily(() => buildDirtyProbe(ctx));
  const scope: ClashScope = {
    removed: deletedPaths(workdir, entries),
    workdir,
    isIgnoredPath: ignoredOccupants === 'protect' ? NEVER_IGNORED : createIgnoredProbe(ctx),
    scanner: createLeadingPathScanner(ctx),
  };
  const offending = await boundedMapFor(ctx, 'ioBound', entries, (entry) =>
    evaluate(ctx, probe, entry, scope),
  );
  const localChanges: FilePath[] = [];
  const untracked: FilePath[] = [];
  for (const result of offending) {
    if (result === undefined) continue;
    if (result.class === 'local-changes') localChanges.push(result.path);
    else untracked.push(result.path);
  }
  // Refusal arrays mirror git's raw-byte path order, matching `findWouldOverwrite`
  // — `changeset.entries` order (UTF-16 from a JS sort upstream) is not faithful
  // for non-ASCII paths.
  return { localChanges: localChanges.sort(comparePaths), untracked: untracked.sort(comparePaths) };
};

const applyDeleteEntry = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
  scanner: LeadingPathScanner,
): Promise<FilePath | undefined> => {
  if (isLossy(entry)) return undefined;
  // git skips a removal silently when the leading directory is a symlink —
  // the delete is never attempted, not refused.
  if (await scanner.hasSymlinkedLeadingPath(entry.path)) return undefined;
  const abs = joinPath(workdir, entry.path);
  // git's unlink_entry removes a gitlink with rmdir, leaving a populated directory in place.
  if (entry.previousMode === FILE_MODE.GITLINK) return removeGitlinkDirectory(ctx, abs, entry.path);
  return (await removeDeletedFile(ctx, abs, entry.path)) ? entry.path : undefined;
};

// git's remove_or_warn: rmdir on a gitlink, warning when a directory refuses to go.
const removeGitlinkDirectory = async (
  ctx: Context,
  abs: string,
  path: FilePath,
): Promise<FilePath | undefined> => {
  if (await removeEmptyDirectory(ctx, abs)) return path;
  if ((await lstatIfReachable(ctx.fs, abs))?.isDirectory === true) {
    ctx.logger?.warn?.(`unable to rmdir '${path}': Directory not empty`);
  }
  return undefined;
};

// git's unlink_entry leaves a directory standing where the entry was (warning),
// and a path beneath a regular file is not there to remove.
const removeDeletedFile = async (ctx: Context, abs: string, path: FilePath): Promise<boolean> => {
  const stat = await lstatIfReachable(ctx.fs, abs);
  if (stat === undefined) return false;
  if (stat.isDirectory) {
    ctx.logger?.warn?.(`unable to unlink '${path}'`);
    return false;
  }
  await ctx.fs.rm(abs);
  return true;
};

// The decoded name would alias a different file, so nothing is written for
// it; the index still records the entry, with a zero stat, under its bytes.
const absentLossyEntry = (entry: ChangesetEntry, id: string): IndexEntry => ({
  ...stage0Entry(entry.path, id as ObjectId, entry.mode),
  ...(entry.pathBytes === undefined ? {} : { pathBytes: entry.pathBytes }),
});

const applyWriteEntry = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
  scanner: LeadingPathScanner,
  writer: WorkingTreeWriter,
): Promise<IndexEntry | undefined> => {
  if (entry.id === undefined) return undefined;
  if (isLossy(entry)) return absentLossyEntry(entry, entry.id);
  const id = entry.id as IndexEntry['id'];
  const written = await writer.writeBlob(entry.path, id, entry.mode, scanner);
  const stat = written ?? (await ctx.fs.lstat(joinPath(workdir, entry.path)));
  return indexEntryFromStat(stat, entry.mode, id, entry.path);
};

interface EntryWaves {
  readonly deletes: ReadonlyArray<ChangesetEntry>;
  readonly writes: ReadonlyArray<ChangesetEntry>;
}

/**
 * Splits the changeset into its two write-side waves. A delete must land
 * before any add/update — `applyEntry`'s write auto-creates missing parent
 * directories, so a stale file/symlink a delete would have cleared must be
 * gone first. The changeset's own `kind` split gives the wave boundary
 * directly; `noop` entries carry no I/O and are dropped here.
 */
const splitWaves = (entries: ReadonlyArray<ChangesetEntry>): EntryWaves => {
  const deletes: ChangesetEntry[] = [];
  const writes: ChangesetEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'delete') deletes.push(entry);
    else if (entry.kind === 'add' || entry.kind === 'update') writes.push(entry);
  }
  return { deletes, writes };
};

/**
 * One counter shared by both waves — `current` increments once per entry as
 * it FINISHES, in completion order, never derived from an index or wave
 * position. That keeps `current` strictly monotone under a concurrent pool
 * and makes `text` always name a path that has already landed on disk.
 */
interface ProgressCounter {
  current: number;
}

const reportCompletion = (
  ctx: Context,
  total: number,
  counter: ProgressCounter,
  path: FilePath,
): void => {
  counter.current += 1;
  ctx.progress.update(CHECKOUT_OP, counter.current, total, path);
};

/**
 * Fans `worker` over `items` through the ioBound pool, like `boundedMapFor`,
 * but never lets a rejection escape while sibling tasks are still running.
 * `boundedMapFor`'s pool is Promise.all semantics (see bounded-map.ts): the
 * first rejection propagates immediately while the OTHER runners keep
 * pulling and writing further entries. Every task dispatched here is a
 * working-tree WRITE, so that race lets pooled writes keep mutating the
 * tree after `applyChangeset` has already thrown back to a caller
 * (`checkout.ts` / `apply-sparse-checkout.ts`) that releases `index.lock`
 * on that same rejection — a partially-applied checkout with no error left
 * to explain it. Mirrors `add.ts`'s `stageWalkedEntries`: record the first
 * error, drain every dispatched task to settlement, then rethrow.
 */
const drainPooled = async <T, R>(
  ctx: Context,
  items: ReadonlyArray<T>,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const limiter = limiterFor(ctx, 'ioBound');
  const results: R[] = [];
  let firstError: { readonly error: unknown } | undefined;
  const pending = items.map((item) =>
    limiter
      .run(() => worker(item))
      .then(
        (result) => {
          results.push(result);
        },
        (error: unknown) => {
          firstError ??= { error };
        },
      ),
  );
  await Promise.all(pending);
  if (firstError !== undefined) throw firstError.error;
  return results;
};

const applyDeleteWave = async (
  ctx: Context,
  workdir: string,
  deletes: ReadonlyArray<ChangesetEntry>,
  surviving: SurvivingDirectories,
  scanner: LeadingPathScanner,
  total: number,
  counter: ProgressCounter,
): Promise<number> => {
  const removed = await drainPooled(ctx, deletes, async (entry) => {
    const path = await applyDeleteEntry(ctx, workdir, entry, scanner);
    reportCompletion(ctx, total, counter, entry.path);
    return path;
  });
  await pruneEmptiedDirectories(
    ctx,
    workdir,
    removed.filter((path) => path !== undefined),
    surviving,
  );
  return deletes.length;
};

/**
 * Groups `writes` by case-folded path. Two changeset entries whose paths
 * differ only by case are a legal shape — a target tree may carry both
 * `File.txt` and `file.txt` as distinct byte-sorted entries — but they
 * collide to the SAME name on a case-insensitive filesystem. Dispatched as
 * independent pool tasks, both writes would interleave against the one
 * underlying path, nondeterministically deciding which content (and
 * post-write lstat) the resulting index entry records. Entries within one
 * group share a single pool slot and apply sequentially, in changeset
 * order; distinct groups still run fully concurrently, so the common case
 * (no collisions) pays nothing extra.
 */
const groupByCaseFoldedPath = (
  entries: ReadonlyArray<ChangesetEntry>,
): ReadonlyArray<ReadonlyArray<ChangesetEntry>> => {
  const order: string[] = [];
  const groups = new Map<string, ChangesetEntry[]>();
  for (const entry of entries) {
    // Stryker disable next-line MethodExpression: equivalent — `key` is purely an internal Map key that groups case-variant paths for serialized writes; it is never exposed to a caller (order.map((key) => groups.get(key)) returns the ChangesetEntry groups, not the key strings), so toUpperCase() groups the identical set of case-variants as toLowerCase() — same partition, different key spelling (hand-verified: apply-changeset.test.ts plus materialize-tree/apply-merge-to-worktree/checkout/status all pass unmutated).
    const key = entry.path.toLowerCase();
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(entry);
  }
  return order.map((key) => groups.get(key) as ChangesetEntry[]);
};

const applyWriteGroup = async (
  ctx: Context,
  workdir: string,
  group: ReadonlyArray<ChangesetEntry>,
  writer: WorkingTreeWriter,
  scanner: LeadingPathScanner,
  total: number,
  counter: ProgressCounter,
): Promise<ReadonlyArray<IndexEntry>> => {
  const written: IndexEntry[] = [];
  for (const entry of group) {
    const indexEntry = await applyWriteEntry(ctx, workdir, entry, scanner, writer);
    reportCompletion(ctx, total, counter, entry.path);
    if (indexEntry !== undefined) written.push(indexEntry);
  }
  return written;
};

const byEntryPath = (a: ChangesetEntry, b: ChangesetEntry): number => comparePaths(a.path, b.path);

/**
 * Whether a long-running filter could serve this checkout. git checks out
 * such entries one at a time, so its one process sees every path in index
 * order — a concurrent wave would ask in completion order.
 */
const convertsThroughFilterProcess = async (ctx: Context): Promise<boolean> => {
  if (ctx.command?.spawn === undefined) return false;
  const drivers = (await readConfig(ctx)).filter?.values() ?? [];
  return [...drivers].some((driver) => driver.process !== undefined && driver.process !== '');
};

type GroupWriter = (entries: ReadonlyArray<ChangesetEntry>) => Promise<ReadonlyArray<IndexEntry>>;

const isLinkWrite = (entry: ChangesetEntry): boolean =>
  entry.mode === FILE_MODE.SYMLINK || entry.mode === FILE_MODE.GITLINK;

const writesSymlink = (writes: ReadonlyArray<ChangesetEntry>): boolean =>
  writes.some((entry) => entry.mode === FILE_MODE.SYMLINK);

// git's create_directories: a leading directory is made one component at a
// time and a link or file in its way is replaced, so the write that follows
// cannot be routed through a link another entry of the wave has created.
const prepareLeadingDirectories = async (
  entry: ChangesetEntry,
  scanner: LeadingPathScanner,
): Promise<void> => {
  if (entry.id === undefined || isLossy(entry)) return;
  await scanner.ensureLeadingDirectories(entry.path);
};

// Memo keys are spellings and a case-folding disk answers for another one, so
// no verdict survives a link write.
const writeLinkAndForget = async (
  group: GroupWriter,
  entry: ChangesetEntry,
  scanner: LeadingPathScanner,
): Promise<ReadonlyArray<IndexEntry>> => {
  const written = await group([entry]);
  scanner.invalidateAll();
  return written;
};

const writePhaseOne = async (
  writes: ReadonlyArray<ChangesetEntry>,
  scanner: LeadingPathScanner,
  group: GroupWriter,
): Promise<ReadonlyArray<IndexEntry>> => {
  const written: IndexEntry[] = [];
  for (const entry of [...writes].sort(byEntryPath)) {
    if (isLinkWrite(entry)) written.push(...(await writeLinkAndForget(group, entry, scanner)));
    else await prepareLeadingDirectories(entry, scanner);
  }
  return written;
};

const writeOneByOne = async (
  sorted: ReadonlyArray<ChangesetEntry>,
  scanner: LeadingPathScanner,
  group: GroupWriter,
): Promise<ReadonlyArray<IndexEntry>> => {
  const written: IndexEntry[] = [];
  for (const entry of sorted) {
    if (isLinkWrite(entry)) {
      written.push(...(await writeLinkAndForget(group, entry, scanner)));
      continue;
    }
    await prepareLeadingDirectories(entry, scanner);
    written.push(...(await group([entry])));
  }
  return written;
};

const writePooled = async (
  ctx: Context,
  writes: ReadonlyArray<ChangesetEntry>,
  scanner: LeadingPathScanner,
  applyGroup: GroupWriter,
): Promise<ReadonlyArray<IndexEntry>> => {
  if (!writesSymlink(writes)) {
    return (await drainPooled(ctx, groupByCaseFoldedPath(writes), applyGroup)).flat();
  }
  const linked = await writePhaseOne(writes, scanner, applyGroup);
  const regulars = writes.filter((entry) => !isLinkWrite(entry));
  const grouped = await drainPooled(ctx, groupByCaseFoldedPath(regulars), applyGroup);
  return [...linked, ...grouped.flat()];
};

const applyWriteWave = async (
  ctx: Context,
  workdir: string,
  writes: ReadonlyArray<ChangesetEntry>,
  writer: WorkingTreeWriter,
  scanner: LeadingPathScanner,
  total: number,
  counter: ProgressCounter,
): Promise<ReadonlyArray<IndexEntry>> => {
  const applyGroup: GroupWriter = (group) =>
    applyWriteGroup(ctx, workdir, group, writer, scanner, total, counter);
  if ((await everySourceLoadable(ctx)) && !(await convertsThroughFilterProcess(ctx))) {
    return writePooled(ctx, writes, scanner, applyGroup);
  }
  // git writes one entry at a time in index order, so its residue under a
  // refused object read is an exact prefix; a concurrent wave would leave an
  // arbitrary subset.
  const sorted = [...writes].sort(byEntryPath);
  return writesSymlink(writes) ? writeOneByOne(sorted, scanner, applyGroup) : applyGroup(sorted);
};

/** The paths this application writes: a noop entry's file may be absent from disk, so it keeps no directory alive. */
function* writtenPaths(entries: ReadonlyArray<ChangesetEntry>): Generator<string> {
  for (const entry of entries)
    if (entry.kind === 'add' || entry.kind === 'update') yield entry.path;
}

const removeIgnoredBelow = async (
  ctx: Context,
  absDir: string,
  isIgnoredPath: IgnoredProbe,
): Promise<void> => {
  for (const child of await ctx.fs.readdir(absDir)) {
    const absChild = joinPath(absDir, child.name);
    if (await isIgnoredPath(absChild, child.isDirectory)) await ctx.fs.rmRecursive(absChild);
    else if (child.isDirectory) {
      await removeIgnoredBelow(ctx, absChild, isIgnoredPath);
      await removeEmptyDirectory(ctx, absChild);
    }
  }
};

// git's remove_subtree: what stands in a directory that becomes a file goes with it.
// Forced, that is everything; otherwise only the ignored files, as the clash check
// already refused anything else. A gitlink leaves its directory alone, and a symlink
// in the leading path is replaced by the write, never followed.
// Forced, every occupant goes; otherwise only the ignored ones, or none when ignored occupants are protected.
type OccupantPolicy = 'every' | 'ignored' | 'protected';

const occupantPolicyOf = (force: boolean, ignoredOccupants: IgnoredOccupants): OccupantPolicy => {
  if (force) return 'every';
  return ignoredOccupants === 'protect' ? 'protected' : 'ignored';
};

const clearDirectoryAt = async (
  ctx: Context,
  absPath: string,
  policy: OccupantPolicy,
  isIgnoredPath: IgnoredProbe,
): Promise<void> => {
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat?.isDirectory !== true) return;
  if (policy === 'every') await ctx.fs.rmRecursive(absPath);
  else if (policy === 'ignored') await removeIgnoredBelow(ctx, absPath, isIgnoredPath);
};

// A regular file standing where a directory is due: forced it goes; otherwise only when
// ignored, as the clash check already refused any other one.
const displaceFile = async (
  ctx: Context,
  workdir: string,
  obstruction: LeadingObstruction,
  policy: OccupantPolicy,
  isIgnoredPath: IgnoredProbe,
  scanner: LeadingPathScanner,
): Promise<void> => {
  const absPath = joinPath(workdir, obstruction.path);
  if (policy === 'every' || (policy === 'ignored' && (await isIgnoredPath(absPath, false)))) {
    await ctx.fs.rm(absPath);
  }
  scanner.invalidate(obstruction.path);
};

const clearOccupants = async (
  ctx: Context,
  workdir: string,
  writes: ReadonlyArray<ChangesetEntry>,
  policy: OccupantPolicy,
  scanner: LeadingPathScanner,
): Promise<void> => {
  const isIgnoredPath = createIgnoredProbe(ctx);
  for (const entry of writes) {
    if (isLossy(entry)) continue;
    const obstruction = await scanner.obstructingLeadingComponent(entry.path);
    if (obstruction?.kind === 'file') {
      await displaceFile(ctx, workdir, obstruction, policy, isIgnoredPath, scanner);
      continue;
    }
    if (obstruction !== undefined) continue;
    if (entry.mode === FILE_MODE.GITLINK) continue;
    await clearDirectoryAt(ctx, joinPath(workdir, entry.path), policy, isIgnoredPath);
  }
};

const applyAllEntries = async (
  ctx: Context,
  deletes: ReadonlyArray<ChangesetEntry>,
  writes: ReadonlyArray<ChangesetEntry>,
  workdir: string,
  writer: WorkingTreeWriter,
  scanner: LeadingPathScanner,
  surviving: SurvivingDirectories,
  policy: OccupantPolicy,
): Promise<ApplyChangesetResult> => {
  const total = deletes.length + writes.length;
  const counter: ProgressCounter = { current: 0 };

  const deleted = await applyDeleteWave(ctx, workdir, deletes, surviving, scanner, total, counter);
  await clearOccupants(ctx, workdir, writes, policy, scanner);
  const writtenEntries = await applyWriteWave(
    ctx,
    workdir,
    writes,
    writer,
    scanner,
    total,
    counter,
  );

  return { writtenEntries, written: writes.length, deleted };
};

export const applyChangeset = (
  ctx: Context,
  opts: ApplyChangesetOpts,
): Promise<ApplyChangesetResult> =>
  withFilterProcessPool(ctx, () => applyChangesetInScope(ctx, opts, undefined));

/** Checkout-direction apply: the writer reads attributes the way git's checkout does. */
export const applyChangesetWithAttributes = (
  ctx: Context,
  opts: ApplyChangesetOpts,
  direction: AttributeDirection,
): Promise<ApplyChangesetResult> =>
  withFilterProcessPool(ctx, () => applyChangesetInScope(ctx, opts, direction));

/** Refuses a changeset that would overwrite local changes or untracked files. */
const assertNoDirtyOverwrite = async (
  ctx: Context,
  workdir: string,
  entries: ReadonlyArray<ChangesetEntry>,
  ignoredOccupants: IgnoredOccupants,
  evaluate: PathEvaluator,
): Promise<void> => {
  const dirty = await checkDirty(ctx, workdir, entries, ignoredOccupants, evaluate);
  if (dirty.localChanges.length > 0 || dirty.untracked.length > 0) {
    throw checkoutOverwriteDirty(dirty);
  }
};

/**
 * One writer per apply. Its smudge limiter is sized off cpuBound, not
 * ioBound: a smudge subprocess spawn is process/CPU-bound, so it must not
 * inherit the write wave's wider ioBound budget.
 */
const createChangesetWriter = (
  ctx: Context,
  opts: ApplyChangesetOpts,
  direction: AttributeDirection | undefined,
): WorkingTreeWriter =>
  createWorkingTreeWriter(ctx, {
    provider: lazily(() =>
      direction === undefined
        ? buildCheckinAttributeProvider(ctx)
        : buildAttributeProvider(ctx, direction),
    ),
    settings: lazily(() => readEolSettings(ctx)),
    limiter: limiterFor(ctx, 'cpuBound'),
    ...(opts.checkoutMetadata && { metadata: opts.checkoutMetadata }),
  });

const applyChangesetInScope = async (
  ctx: Context,
  opts: ApplyChangesetOpts,
  direction: AttributeDirection | undefined,
): Promise<ApplyChangesetResult> => {
  const { changeset, force, workdir } = opts;
  const ignoredOccupants = opts.ignoredOccupants ?? 'overwrite';

  validateChangesetPaths(indexPathRulesOf(ctx), changeset);

  // Hoisted above the dirty check so a `noop`-heavy changeset never
  // pays a dirty probe — or a pool slot — for entries that carry no I/O.
  const { deletes, writes } = splitWaves(changeset.entries);

  const evaluate = preflightOf(
    force,
    opts.untrackedOccupants ?? 'overwrite',
    opts.unmergedPaths ?? 'hidden',
  );
  if (evaluate !== undefined) {
    await assertNoDirtyOverwrite(ctx, workdir, [...deletes, ...writes], ignoredOccupants, evaluate);
  }

  // One scanner per changeset application, shared by BOTH the delete-skip
  // check and the write-side unlink: its per-directory memo means a deep
  // tree with many entries under the same symlinked directory costs one
  // `lstat` per distinct directory, not one per entry.
  const scanner = createLeadingPathScanner(ctx);
  const writer = createChangesetWriter(ctx, opts, direction);
  // Only a deletion can empty a directory, so a deletion-free changeset derives nothing.
  const surviving = survivingDirectoriesOf(
    // Stryker disable next-line ArrayDeclaration: equivalent — without a deletion nothing is scheduled for pruning, so the surviving set is never consulted.
    deletes.length === 0 ? [] : writtenPaths(changeset.entries),
  );
  return applyAllEntries(
    ctx,
    deletes,
    writes,
    workdir,
    writer,
    scanner,
    surviving,
    occupantPolicyOf(force, ignoredOccupants),
  );
};

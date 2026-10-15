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
import { type IndexEntry, STAGE0_FLAGS } from '../../domain/git-index/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { Changeset, ChangesetEntry } from './compute-changeset.js';
import { readConfig } from './config-read.js';
import type { CheckoutMetadata } from './internal/apply-smudge-filter.js';
import { boundedMapFor, limiterFor } from './internal/concurrency.js';
import { convertToGit } from './internal/convert-blob.js';
import { withFilterProcessPool } from './internal/filter-process-pool.js';
import { joinPath } from './internal/join-working-tree-path.js';
import { lazily } from './internal/lazily.js';
import { pathIsOccupied } from './internal/path-occupied.js';
import {
  type AttributeDirection,
  type AttributeProvider,
  buildAttributeProvider,
  buildCheckinAttributeProvider,
} from './internal/read-gitattributes.js';
import { requireWorkTree } from './internal/repo-state.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';
import {
  createWorkingTreeWriter,
  type WorkingTreeWriter,
} from './internal/write-converted-entry.js';
import { rmIfExists } from './internal/write-working-tree-file.js';
import { everySourceLoadable } from './object-store.js';
import { readEolSettings, resolveConversion } from './resolve-conversion.js';

export interface ApplyChangesetOpts {
  readonly changeset: Changeset;
  readonly force: boolean;
  readonly workdir: string;
  /** The ref and commit the checkout moves to, told to a smudging process filter. */
  readonly checkoutMetadata?: CheckoutMetadata;
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

const repoRelativePath = (ctx: Context, absPath: string): FilePath =>
  absPath.slice(requireWorkTree(ctx, 'isWorkingTreeDirty').length + 1) as FilePath;

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

const isUntrackedClash = async (ctx: Context, absPath: string): Promise<boolean> =>
  pathIsOccupied(ctx, absPath);

interface DirtyClass {
  readonly class: 'local-changes' | 'untracked';
  readonly path: FilePath;
}

const evaluateDirtyPath = async (
  ctx: Context,
  probe: () => Promise<DirtyProbe>,
  workdir: string,
  entry: ChangesetEntry,
): Promise<DirtyClass | undefined> => {
  const absPath = joinPath(workdir, entry.path);
  if (entry.kind === 'update' || entry.kind === 'delete') {
    if (entry.previousId === undefined) return undefined;
    return (await isDirtyUnder(ctx, await probe(), entry.path, absPath, entry.previousId))
      ? { class: 'local-changes', path: entry.path }
      : undefined;
  }
  if (entry.kind === 'add') {
    return (await isUntrackedClash(ctx, absPath))
      ? { class: 'untracked', path: entry.path }
      : undefined;
  }
  return undefined;
};

// The checkout path's tree->index boundary. Every `add`/`update` entry
// carries a path sourced from a target-tree walk (`walkTree` never
// validates entry names — that is git's `mktree` escape hatch), so each
// one is re-checked here before `applyAllEntries` writes anything.
// `delete`/`noop` entries are skipped: their path already passed this same
// check when the CURRENT index was parsed (`index-parser.ts`).
const validateChangesetEntry = (entry: ChangesetEntry): void => {
  // Stryker disable next-line ConditionalExpression: equivalent — computeChangeset sources a `delete`/`noop` entry's `path` AND `mode` unchanged from the current index (`classify` in compute-changeset.ts), which index-parser.ts already ran through this same validateIndexPath(path, _, mode) at parse time; the throw decision depends only on (path, mode), not offset, so re-running it on an already-validated pair can never newly throw.
  if (entry.kind !== 'add' && entry.kind !== 'update') return;
  validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode);
};

const validateChangesetPaths = (changeset: Changeset): void => {
  for (const entry of changeset.entries) validateChangesetEntry(entry);
};

const checkDirty = async (
  ctx: Context,
  workdir: string,
  entries: ReadonlyArray<ChangesetEntry>,
): Promise<WouldOverwriteClasses> => {
  // Fanned out through the ioBound pool — pure reads, so collection order
  // is free: refusal arrays are sorted with `comparePaths` below regardless
  // of which entry's probe lands first. `entries` is the caller's
  // pre-split delete+write waves, never raw `changeset.entries` — a `noop`
  // entry needs no dirty probe at all, so skipping it here avoids both a
  // wasted pool slot and an oversized `boundedMap` allocation.
  const probe = lazily(() => buildDirtyProbe(ctx));
  const offending = await boundedMapFor(ctx, 'ioBound', entries, (entry) =>
    evaluateDirtyPath(ctx, probe, workdir, entry),
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

const buildIndexEntry = async (
  ctx: Context,
  absPath: string,
  relPath: FilePath,
  id: string,
  mode: FileMode,
  pathBytes: Uint8Array | undefined,
): Promise<IndexEntry> => {
  const stat = await ctx.fs.lstat(absPath);
  return {
    ctimeSeconds: Math.floor(stat.ctimeMs / 1000),
    ctimeNanoseconds: Number(stat.ctimeNs ?? 0n) % 1_000_000_000,
    mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
    mtimeNanoseconds: Number(stat.mtimeNs ?? 0n) % 1_000_000_000,
    dev: stat.dev,
    ino: stat.ino,
    mode,
    uid: stat.uid,
    gid: stat.gid,
    fileSize: stat.size,
    id: id as IndexEntry['id'],
    flags: STAGE0_FLAGS,
    path: relPath,
    ...(pathBytes === undefined ? {} : { pathBytes }),
  };
};

const applyDeleteEntry = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
  scanner: LeadingPathScanner,
): Promise<void> => {
  // git skips a removal silently when the leading directory is a symlink —
  // the delete is never attempted, not refused.
  if (await scanner.hasSymlinkedLeadingPath(entry.path)) return;
  await rmIfExists(ctx, joinPath(workdir, entry.path));
};

const applyWriteEntry = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
  scanner: LeadingPathScanner,
  writer: WorkingTreeWriter,
): Promise<IndexEntry | undefined> => {
  if (entry.id === undefined) return undefined;
  const absPath = joinPath(workdir, entry.path);
  await writer.writeBlob(entry.path, entry.id as IndexEntry['id'], entry.mode, scanner);
  return buildIndexEntry(ctx, absPath, entry.path, entry.id, entry.mode, entry.pathBytes);
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
  scanner: LeadingPathScanner,
  total: number,
  counter: ProgressCounter,
): Promise<number> => {
  await drainPooled(ctx, deletes, async (entry) => {
    await applyDeleteEntry(ctx, workdir, entry, scanner);
    reportCompletion(ctx, total, counter, entry.path);
  });
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

const applyWriteWave = async (
  ctx: Context,
  workdir: string,
  writes: ReadonlyArray<ChangesetEntry>,
  writer: WorkingTreeWriter,
  scanner: LeadingPathScanner,
  total: number,
  counter: ProgressCounter,
): Promise<ReadonlyArray<IndexEntry>> => {
  const applyGroup = (group: ReadonlyArray<ChangesetEntry>) =>
    applyWriteGroup(ctx, workdir, group, writer, scanner, total, counter);
  if ((await everySourceLoadable(ctx)) && !(await convertsThroughFilterProcess(ctx))) {
    const grouped = await drainPooled(ctx, groupByCaseFoldedPath(writes), applyGroup);
    return grouped.flat();
  }
  // git writes one entry at a time in index order, so its residue under a
  // refused object read is an exact prefix; a concurrent wave would leave an
  // arbitrary subset.
  return applyGroup([...writes].sort(byEntryPath));
};

const applyAllEntries = async (
  ctx: Context,
  deletes: ReadonlyArray<ChangesetEntry>,
  writes: ReadonlyArray<ChangesetEntry>,
  workdir: string,
  writer: WorkingTreeWriter,
  scanner: LeadingPathScanner,
): Promise<ApplyChangesetResult> => {
  const total = deletes.length + writes.length;
  const counter: ProgressCounter = { current: 0 };

  const deleted = await applyDeleteWave(ctx, workdir, deletes, scanner, total, counter);
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
): Promise<void> => {
  const dirty = await checkDirty(ctx, workdir, entries);
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

  validateChangesetPaths(changeset);

  // Hoisted above the dirty check so a `noop`-heavy changeset never
  // pays a dirty probe — or a pool slot — for entries that carry no I/O.
  const { deletes, writes } = splitWaves(changeset.entries);

  if (!force) await assertNoDirtyOverwrite(ctx, workdir, [...deletes, ...writes]);

  // One scanner per changeset application, shared by BOTH the delete-skip
  // check and the write-side unlink: its per-directory memo means a deep
  // tree with many entries under the same symlinked directory costs one
  // `lstat` per distinct directory, not one per entry.
  const scanner = createLeadingPathScanner(ctx);
  const writer = createChangesetWriter(ctx, opts, direction);
  return applyAllEntries(ctx, deletes, writes, workdir, writer, scanner);
};

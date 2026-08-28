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
import {
  checkoutOverwriteDirty,
  smudgeFilterFailed,
  type WouldOverwriteClasses,
} from '../../domain/commands/error.js';
import { comparePaths } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../domain/git-index/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';
import type { Changeset, ChangesetEntry } from './compute-changeset.js';
import { boundedMapFor, limiterFor } from './internal/concurrency.js';
import type { ConcurrencyLimiter } from './internal/concurrency-limiter.js';
import { joinPath } from './internal/join-working-tree-path.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';
import {
  rmIfExists,
  writeWorkingTreeEntry,
  writeWorkingTreeEntryStream,
} from './internal/write-working-tree-file.js';
import { readBlob } from './read-blob.js';
import { resolveFilterDriver } from './resolve-filter-driver.js';
import { runFilterDriver } from './run-filter-driver.js';
import { streamBlob } from './stream-blob.js';

export interface ApplyChangesetOpts {
  readonly changeset: Changeset;
  readonly force: boolean;
  readonly workdir: string;
}

export interface ApplyChangesetResult {
  readonly writtenEntries: ReadonlyArray<IndexEntry>;
  readonly written: number;
  readonly deleted: number;
}

const CHECKOUT_OP = 'checkout:materialize';

const LINK_ENCODER = new TextEncoder();

const blobMatches = async (ctx: Context, absPath: string, expectedId: string): Promise<boolean> => {
  let bytes: Uint8Array;
  try {
    const stat = await ctx.fs.lstat(absPath);
    bytes = stat.isSymbolicLink
      ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath))
      : await ctx.fs.read(absPath);
  } catch (err) {
    // FILE_NOT_FOUND on a `delete`/`update` target means the file is already
    // gone — treat as non-dirty so the apply step proceeds as a no-op.
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return true;
    // PERMISSION_DENIED and other read failures are NOT silently overwritten —
    // re-throw so the caller surfaces the underlying error instead of
    // clobbering an unreadable file.
    throw err;
  }
  // Compute the loose-object content hash via the shared serialise+hash core
  // (the `blob <size>\0` header git stored), so this matches `writeObject` /
  // `hashBlob` byte-for-byte. Uncapped: a read-only dirty check never throws on
  // a large working file.
  const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content: bytes });
  return id === expectedId;
};

/**
 * `true` when a working-tree file exists at `absPath` but its blob content
 * hash differs from `expectedId`. An absent file is not dirty. Shared by
 * `applySparseCheckout`'s narrowing pre-scan (design §9).
 */
export const isWorkingTreeDirty = async (
  ctx: Context,
  absPath: string,
  expectedId: string,
): Promise<boolean> => {
  if (!(await ctx.fs.exists(absPath))) return false;
  return !(await blobMatches(ctx, absPath, expectedId));
};

const isUntrackedClash = async (ctx: Context, absPath: string): Promise<boolean> =>
  ctx.fs.exists(absPath);

interface DirtyClass {
  readonly class: 'local-changes' | 'untracked';
  readonly path: FilePath;
}

const evaluateDirtyPath = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
): Promise<DirtyClass | undefined> => {
  const absPath = joinPath(workdir, entry.path);
  if (entry.kind === 'update' || entry.kind === 'delete') {
    if (entry.previousId === undefined) return undefined;
    return (await isWorkingTreeDirty(ctx, absPath, entry.previousId))
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
  const offending = await boundedMapFor(ctx, 'ioBound', entries, (entry) =>
    evaluateDirtyPath(ctx, workdir, entry),
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
  };
};

const writeBlobToWorkingTree = async (
  ctx: Context,
  path: FilePath,
  id: IndexEntry['id'],
  mode: FileMode,
  scanner: LeadingPathScanner,
  filterLimiter: ConcurrencyLimiter,
  provider?: AttributeProvider,
): Promise<void> => {
  if (mode === FILE_MODE.GITLINK) {
    await writeWorkingTreeEntry(ctx, path, new Uint8Array(), mode, scanner);
    return;
  }
  if (mode === FILE_MODE.SYMLINK) {
    const blob = await readBlob(ctx, id);
    await writeWorkingTreeEntry(ctx, path, blob.content, mode, scanner);
    return;
  }
  if (provider !== undefined && ctx.command !== undefined) {
    const command: CommandRunner = ctx.command;
    const choice = await resolveFilterDriver(ctx, provider, path, {
      eagerSectionValidation: true,
    });
    if (choice.kind === 'external' && choice.smudge !== undefined) {
      const blob = await readBlob(ctx, id);
      const smudge = choice.smudge;
      // A smudge filter spawns a subprocess — CPU/process-bound, not
      // blocking-fd-bound — so it must not inherit the write wave's wider
      // ioBound budget (P10): `filterLimiter` is sized off cpuBound and
      // shared for the whole changeset apply, bounding how many subprocess
      // spawns run at once regardless of how many writes the ioBound pool
      // has in flight. The write itself, below, stays on the full pool.
      const result = await filterLimiter.run(() =>
        runFilterDriver(ctx, command, smudge, blob.content),
      );
      if (!result.ok) {
        if (choice.required) {
          throw smudgeFilterFailed(path, choice.name, result.exitCode);
        }
        await writeWorkingTreeEntry(ctx, path, blob.content, mode, scanner);
        return;
      }
      await writeWorkingTreeEntry(ctx, path, result.bytes, mode, scanner);
      return;
    }
  }
  const stream = await streamBlob(ctx, id);
  await writeWorkingTreeEntryStream(ctx, path, stream, mode, scanner);
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
  filterLimiter: ConcurrencyLimiter,
  provider: AttributeProvider | undefined,
): Promise<IndexEntry | undefined> => {
  if (entry.id === undefined) return undefined;
  const absPath = joinPath(workdir, entry.path);
  await writeBlobToWorkingTree(
    ctx,
    entry.path,
    entry.id as IndexEntry['id'],
    entry.mode,
    scanner,
    filterLimiter,
    provider,
  );
  return buildIndexEntry(ctx, absPath, entry.path, entry.id, entry.mode);
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

const applyWriteWave = async (
  ctx: Context,
  workdir: string,
  writes: ReadonlyArray<ChangesetEntry>,
  lazyProvider: () => Promise<AttributeProvider>,
  scanner: LeadingPathScanner,
  filterLimiter: ConcurrencyLimiter,
  total: number,
  counter: ProgressCounter,
): Promise<ReadonlyArray<IndexEntry>> => {
  const groups = groupByCaseFoldedPath(writes);
  const grouped = await drainPooled(ctx, groups, async (group) => {
    const written: IndexEntry[] = [];
    for (const entry of group) {
      const provider = ctx.command !== undefined ? await lazyProvider() : undefined;
      const indexEntry = await applyWriteEntry(
        ctx,
        workdir,
        entry,
        scanner,
        filterLimiter,
        provider,
      );
      reportCompletion(ctx, total, counter, entry.path);
      if (indexEntry !== undefined) written.push(indexEntry);
    }
    return written;
  });
  return grouped.flat();
};

const applyAllEntries = async (
  ctx: Context,
  deletes: ReadonlyArray<ChangesetEntry>,
  writes: ReadonlyArray<ChangesetEntry>,
  workdir: string,
  lazyProvider: () => Promise<AttributeProvider>,
  scanner: LeadingPathScanner,
  filterLimiter: ConcurrencyLimiter,
): Promise<ApplyChangesetResult> => {
  const total = deletes.length + writes.length;
  const counter: ProgressCounter = { current: 0 };

  const deleted = await applyDeleteWave(ctx, workdir, deletes, scanner, total, counter);
  const writtenEntries = await applyWriteWave(
    ctx,
    workdir,
    writes,
    lazyProvider,
    scanner,
    filterLimiter,
    total,
    counter,
  );

  return { writtenEntries, written: writes.length, deleted };
};

export const applyChangeset = async (
  ctx: Context,
  opts: ApplyChangesetOpts,
): Promise<ApplyChangesetResult> => {
  const { changeset, force, workdir } = opts;

  validateChangesetPaths(changeset);

  // Hoisted above the dirty check (P9) so a `noop`-heavy changeset never
  // pays a dirty probe — or a pool slot — for entries that carry no I/O.
  const { deletes, writes } = splitWaves(changeset.entries);

  if (!force) {
    const dirty = await checkDirty(ctx, workdir, [...deletes, ...writes]);
    if (dirty.localChanges.length > 0 || dirty.untracked.length > 0) {
      throw checkoutOverwriteDirty(dirty);
    }
  }

  // Build attribute provider lazily once per invocation (mirror build-content-merger.ts:48).
  // Skip entirely when no runner is wired (R11 inert fallback — ADR-408).
  let providerPromise: Promise<AttributeProvider> | undefined;
  const lazyProvider = (): Promise<AttributeProvider> =>
    (providerPromise ??= buildAttributeProvider(ctx));

  // One scanner per changeset application, shared by BOTH the delete-skip
  // check and the write-side unlink: its per-directory memo means a deep
  // tree with many entries under the same symlinked directory costs one
  // `lstat` per distinct directory, not one per entry.
  const scanner = createLeadingPathScanner(ctx);
  // Sized off cpuBound, not ioBound (P10): a smudge subprocess spawn is
  // process/CPU-bound, not blocking-fd-bound, so it must not inherit the
  // write wave's wider ioBound budget — see `writeBlobToWorkingTree`.
  const filterLimiter = limiterFor(ctx, 'cpuBound');
  return applyAllEntries(ctx, deletes, writes, workdir, lazyProvider, scanner, filterLimiter);
};

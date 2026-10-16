/**
 * The sparse-checkout apply engine — re-shapes the working tree to match a
 * `SparseMatcher`, operating on the current index (which already holds the
 * whole tree). Used by the `sparseCheckout` command's `set` / `add` /
 * `reapply` / `disable` actions.
 *
 * Layering: this is command-internal machinery — it depends on
 * `acquireIndexLock` (a `commands/internal` member), so it lives here, not
 * under `primitives/` (a primitive importing `commands/` breaks the hexagonal
 * dependency rule).
 */
import { type IndexEntry, skipWorktreeEntry } from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
  isLossy,
} from '../../../domain/git-index/index-path-key.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { SparseMatcher } from '../../../domain/sparse/index.js';
import type { Context } from '../../../ports/context.js';
import {
  applyChangesetWithAttributes,
  createWorkingTreeDirtyCheck,
} from '../../primitives/apply-changeset.js';
import type { Changeset, ChangesetEntry } from '../../primitives/compute-changeset.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { attributeBlobLookup } from '../../primitives/internal/read-gitattributes.js';
import { requireWorkTree } from '../../primitives/internal/repo-state.js';
import { readIndex } from '../../primitives/read-index.js';
import { acquireIndexLock } from './index-update.js';

export interface ApplySparseCheckoutOpts {
  /** `undefined` ⇒ "include everything" (the `disable` path). */
  readonly matcher: SparseMatcher | undefined;
  /** Overwrite locally-modified files the matcher would now exclude. */
  readonly force?: boolean;
}

export interface ApplySparseCheckoutResult {
  /** Files written into the working tree. */
  readonly materialized: number;
  /** Files deleted from the working tree. */
  readonly removed: number;
  /** Dirty excludees left in place (skip-worktree NOT set). */
  readonly retained: ReadonlyArray<FilePath>;
}

/** An excluded entry paired with whether its working-tree file is on disk. */
interface ExcludedEntry {
  readonly entry: IndexEntry;
  /** Result of the single `ctx.fs.exists` check from the partition step. */
  readonly present: boolean;
}

/** A stage-0 index entry partitioned by the matcher's verdict. */
interface Partitioned {
  /** In-pattern entries — materialised, skip-worktree cleared. */
  readonly included: ReadonlyArray<IndexEntry>;
  /** Out-of-pattern entries that are clean (or forced) — removable. */
  readonly removable: ReadonlyArray<ExcludedEntry>;
  /** Out-of-pattern entries with uncommitted edits — retained, left on disk. */
  readonly retained: ReadonlyArray<IndexEntry>;
}

const isIncluded = (matcher: SparseMatcher | undefined, entry: IndexEntry): boolean =>
  matcher === undefined ? true : matcher(escapedPathOf(entry));

/** `path`, plus `pathBytes` only for a lossy entry — a lossy entry never aliases its UTF-8 twin. */
const changesetPathOf = (entry: IndexEntry): Pick<ChangesetEntry, 'path' | 'pathBytes'> => ({
  path: entry.path,
  ...(entry.pathBytes === undefined ? {} : { pathBytes: entry.pathBytes }),
});

/**
 * Partition stage-0 entries. An excluded entry whose working-tree file exists
 * and is dirty is retained unless `force`; otherwise it is removable. The
 * single `ctx.fs.exists` result for each excluded path is threaded onto the
 * removable entry so `buildChangeset` need not re-check the same path.
 */
const partition = async (
  ctx: Context,
  workdir: string,
  entries: ReadonlyArray<IndexEntry>,
  opts: ApplySparseCheckoutOpts,
): Promise<Partitioned> => {
  const included: IndexEntry[] = [];
  const removable: ExcludedEntry[] = [];
  const retained: IndexEntry[] = [];
  const isDirty = createWorkingTreeDirtyCheck(ctx);
  for (const entry of entries) {
    if (isIncluded(opts.matcher, entry)) {
      included.push(entry);
      continue;
    }
    if (isLossy(entry)) {
      removable.push({ entry, present: false });
      continue;
    }
    const absPath = joinPath(workdir, entry.path);
    const present = await ctx.fs.exists(absPath);
    const dirty = present ? await isDirty(absPath, entry.id) : false;
    if (dirty && opts.force !== true) retained.push(entry);
    else removable.push({ entry, present });
  }
  return { included, removable, retained };
};

/** A `delete` changeset entry for an excluded file currently on disk. */
const deleteEntry = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'delete',
  ...changesetPathOf(entry),
  mode: entry.mode,
  id: undefined,
  previousId: entry.id,
  previousMode: entry.mode,
});

/** An `add` changeset entry for an included file currently absent from disk. */
const addEntry = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'add',
  ...changesetPathOf(entry),
  mode: entry.mode,
  id: entry.id,
  previousId: undefined,
  previousMode: undefined,
});

/** A `noop` changeset entry — the file already matches its desired state. */
const noopEntry = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'noop',
  ...changesetPathOf(entry),
  mode: entry.mode,
  id: entry.id,
  previousId: entry.id,
  previousMode: entry.mode,
});

/** An included entry is `noop` when its file is on disk, else `add`; a lossy one is never probed, its decoded name being another file. */
const includedChange = async (
  ctx: Context,
  workdir: string,
  entry: IndexEntry,
): Promise<ChangesetEntry> => {
  if (isLossy(entry)) return addEntry(entry);
  const present = await ctx.fs.exists(joinPath(workdir, entry.path));
  return present ? noopEntry(entry) : addEntry(entry);
};

/**
 * Build the changeset that re-shapes the working tree: `delete` every
 * removable excluded file still on disk, `add` every included file currently
 * absent, `noop` everything else. Removable entries reuse the existence
 * result the partition step already computed; only included entries are
 * stat-checked here, never a lossy one.
 */
const buildChangeset = async (
  ctx: Context,
  workdir: string,
  part: Partitioned,
): Promise<Changeset> => {
  const entries: ChangesetEntry[] = [];
  for (const { entry, present } of part.removable) {
    entries.push(present ? deleteEntry(entry) : noopEntry(entry));
  }
  for (const entry of part.included) entries.push(await includedChange(ctx, workdir, entry));
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };
  for (const e of entries) stats[e.kind] += 1;
  return { entries, stats };
};

/** An included entry — skip-worktree always cleared (a stale bit is dropped). */
const clearSkipWorktree = (entry: IndexEntry): IndexEntry =>
  entry.flags.skipWorktree ? { ...entry, flags: { ...entry.flags, skipWorktree: false } } : entry;

/**
 * Assemble the post-apply index entry list: included entries take their
 * fresh post-write record when `applyChangeset` wrote them, otherwise their
 * prior record with skip-worktree cleared; removable excludees become
 * skip-worktree; retained excludees stay on disk so their skip-worktree bit
 * is cleared — `status` must see the now-present dirty file.
 */
const assembleEntries = (
  part: Partitioned,
  writtenEntries: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  const writtenByPath = new Map<IndexPathKey, IndexEntry>();
  for (const entry of writtenEntries) writtenByPath.set(indexPathKey(entry), entry);
  const out: IndexEntry[] = [];
  for (const entry of part.included) {
    out.push(writtenByPath.get(indexPathKey(entry)) ?? clearSkipWorktree(entry));
  }
  for (const { entry } of part.removable) out.push(skipWorktreeEntry(entry));
  for (const entry of part.retained) out.push(clearSkipWorktree(entry));
  return out;
};

/**
 * Re-shape the working tree to match `opts.matcher` and rewrite the index
 * with skip-worktree bits. Runs under `acquireIndexLock`; the index is read
 * inside the lock. Returns the materialised / removed / retained counts.
 */
export const applySparseCheckout = async (
  ctx: Context,
  opts: ApplySparseCheckoutOpts,
): Promise<ApplySparseCheckoutResult> => {
  const workdir = requireWorkTree(ctx, 'sparse-checkout');
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx);
    const stage0 = index.entries.filter((entry) => entry.flags.stage === 0);
    const part = await partition(ctx, workdir, stage0, opts);
    const changeset = await buildChangeset(ctx, workdir, part);
    const applied = await applyChangesetWithAttributes(
      ctx,
      { changeset, force: true, workdir },
      { kind: 'index-first', index: attributeBlobLookup(stage0) },
    );
    const newEntries = assembleEntries(part, applied.writtenEntries);
    await lock.commit(newEntries, 'update');
    return {
      materialized: applied.written,
      removed: applied.deleted,
      retained: part.retained.map((entry) => entry.path),
    };
  } finally {
    await lock.release();
  }
};

/**
 * The sparse-checkout apply engine — re-shapes the working tree to match a
 * `SparseMatcher`, operating on the current index (which already holds the
 * whole tree). Used by the `sparseCheckout` command's `set` / `add` /
 * `reapply` / `disable` actions (design §7.4).
 *
 * Layering: this is command-internal machinery — it depends on
 * `acquireIndexLock` (a `commands/internal` member), so it lives here, not
 * under `primitives/` (a primitive importing `commands/` breaks the hexagonal
 * dependency rule).
 */
import { type IndexEntry, STAGE0_FLAGS } from '../../../domain/git-index/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { SparseMatcher } from '../../../domain/sparse/index.js';
import type { Context } from '../../../ports/context.js';
import { applyChangeset, isWorkingTreeDirty } from '../../primitives/apply-changeset.js';
import type { Changeset, ChangesetEntry } from '../../primitives/compute-changeset.js';
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

/** A stage-0 index entry partitioned by the matcher's verdict. */
interface Partitioned {
  /** In-pattern entries — materialised, skip-worktree cleared. */
  readonly included: ReadonlyArray<IndexEntry>;
  /** Out-of-pattern entries that are clean (or forced) — removable. */
  readonly removable: ReadonlyArray<IndexEntry>;
  /** Out-of-pattern entries with uncommitted edits — retained, left on disk. */
  readonly retained: ReadonlyArray<IndexEntry>;
}

/**
 * Join a working-tree-relative path onto the workdir. A doubled separator
 * (when `workdir` already ends with `/`) is harmless — node and memory FS
 * both normalise `//`, the same property `read-gitignore` relies on.
 */
const joinPath = (workdir: string, rel: FilePath): string => `${workdir}/${rel}`;

const isIncluded = (matcher: SparseMatcher | undefined, path: FilePath): boolean =>
  matcher === undefined ? true : matcher(path);

/**
 * Partition stage-0 entries. An excluded entry whose working-tree file exists
 * and is dirty is retained unless `force`; otherwise it is removable.
 */
const partition = async (
  ctx: Context,
  workdir: string,
  entries: ReadonlyArray<IndexEntry>,
  opts: ApplySparseCheckoutOpts,
): Promise<Partitioned> => {
  const included: IndexEntry[] = [];
  const removable: IndexEntry[] = [];
  const retained: IndexEntry[] = [];
  for (const entry of entries) {
    if (isIncluded(opts.matcher, entry.path)) {
      included.push(entry);
      continue;
    }
    const absPath = joinPath(workdir, entry.path);
    const dirty = (await ctx.fs.exists(absPath))
      ? await isWorkingTreeDirty(ctx, absPath, entry.id)
      : false;
    if (dirty && opts.force !== true) retained.push(entry);
    else removable.push(entry);
  }
  return { included, removable, retained };
};

/** A `delete` changeset entry for an excluded file currently on disk. */
const deleteEntry = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'delete',
  path: entry.path,
  mode: entry.mode,
  id: undefined,
  previousId: entry.id,
  previousMode: entry.mode,
});

/** An `add` changeset entry for an included file currently absent from disk. */
const addEntry = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'add',
  path: entry.path,
  mode: entry.mode,
  id: entry.id,
  previousId: undefined,
  previousMode: undefined,
});

/** A `noop` changeset entry — the file already matches its desired state. */
const noopEntry = (entry: IndexEntry): ChangesetEntry => ({
  kind: 'noop',
  path: entry.path,
  mode: entry.mode,
  id: entry.id,
  previousId: entry.id,
  previousMode: entry.mode,
});

/**
 * Build the changeset that re-shapes the working tree: `delete` every
 * removable excluded file still on disk, `add` every included file currently
 * absent, `noop` everything else.
 */
const buildChangeset = async (
  ctx: Context,
  workdir: string,
  part: Partitioned,
): Promise<Changeset> => {
  const entries: ChangesetEntry[] = [];
  for (const entry of part.removable) {
    const present = await ctx.fs.exists(joinPath(workdir, entry.path));
    entries.push(present ? deleteEntry(entry) : noopEntry(entry));
  }
  for (const entry of part.included) {
    const present = await ctx.fs.exists(joinPath(workdir, entry.path));
    entries.push(present ? noopEntry(entry) : addEntry(entry));
  }
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };
  for (const e of entries) stats[e.kind] += 1;
  return { entries, stats };
};

/** Stat fields zeroed — the excluded file is gone, `status` skips the entry. */
const ZEROED_STAT = {
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  uid: 0,
  gid: 0,
  fileSize: 0,
} as const;

/** An excluded entry — skip-worktree set, stat zeroed, `id` / `mode` kept. */
const toSkipWorktree = (entry: IndexEntry): IndexEntry => ({
  ...ZEROED_STAT,
  mode: entry.mode,
  id: entry.id,
  flags: { ...STAGE0_FLAGS, skipWorktree: true },
  path: entry.path,
});

/** An included entry — skip-worktree always cleared (a stale bit is dropped). */
const clearSkipWorktree = (entry: IndexEntry): IndexEntry =>
  entry.flags.skipWorktree ? { ...entry, flags: { ...entry.flags, skipWorktree: false } } : entry;

/**
 * Assemble the post-apply index entry list: included entries take their
 * fresh post-write record when `applyChangeset` wrote them, otherwise their
 * prior record with skip-worktree cleared; removable excludees become
 * skip-worktree; retained excludees pass through unchanged.
 */
const assembleEntries = (
  part: Partitioned,
  writtenEntries: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  const writtenByPath = new Map<FilePath, IndexEntry>();
  for (const entry of writtenEntries) writtenByPath.set(entry.path, entry);
  const out: IndexEntry[] = [];
  for (const entry of part.included) {
    out.push(writtenByPath.get(entry.path) ?? clearSkipWorktree(entry));
  }
  for (const entry of part.removable) out.push(toSkipWorktree(entry));
  for (const entry of part.retained) out.push(entry);
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
  const workdir = ctx.layout.workDir;
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx);
    const stage0 = index.entries.filter((entry) => entry.flags.stage === 0);
    const part = await partition(ctx, workdir, stage0, opts);
    const changeset = await buildChangeset(ctx, workdir, part);
    const applied = await applyChangeset(ctx, { changeset, force: true, workdir });
    const newEntries = assembleEntries(part, applied.writtenEntries);
    await lock.commit(newEntries);
    return {
      materialized: applied.written,
      removed: applied.deleted,
      retained: part.retained.map((entry) => entry.path),
    };
  } finally {
    await lock.release();
  }
};

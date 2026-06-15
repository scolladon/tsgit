/**
 * Apply a Changeset to the working tree + return new IndexEntry records.
 *
 * Lifecycle:
 *  1. Dirty-tree guard (unless `force`): hash any working-tree file that
 *  `update`/`delete` would touch and compare against the changeset's
 *  `previousId`. Untracked paths that `add` would clobber are also
 *  flagged. Collected paths surface as CHECKOUT_OVERWRITE_DIRTY.
 *  2. Apply each non-noop entry — `delete` then `add`/`update` per path,
 *  with per-file progress ticks.
 *  3. Build new stage-0 IndexEntry records from the post-write lstat.
 *
 * Atomicity: per-file (matches canonical git). No cross-file rollback —
 * see.
 */
import { checkoutOverwriteDirty, type WouldOverwriteClasses } from '../../domain/commands/error.js';
import { comparePaths } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../domain/git-index/index.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { Changeset, ChangesetEntry } from './compute-changeset.js';
import { serializeAndHash } from './internal/serialize-and-hash.js';
import { joinPath, rmIfExists, writeWorkingTreeEntry } from './internal/write-working-tree-file.js';
import { readBlob } from './read-blob.js';

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

const blobMatches = async (ctx: Context, absPath: string, expectedId: string): Promise<boolean> => {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(absPath);
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

const checkDirty = async (
  ctx: Context,
  workdir: string,
  changeset: Changeset,
): Promise<WouldOverwriteClasses> => {
  const localChanges: FilePath[] = [];
  const untracked: FilePath[] = [];
  for (const entry of changeset.entries) {
    const offending = await evaluateDirtyPath(ctx, workdir, entry);
    if (offending === undefined) continue;
    if (offending.class === 'local-changes') localChanges.push(offending.path);
    else untracked.push(offending.path);
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

const applyEntry = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
): Promise<IndexEntry | undefined> => {
  const absPath = joinPath(workdir, entry.path);
  if (entry.kind === 'noop') return undefined;
  if (entry.kind === 'delete') {
    await rmIfExists(ctx, absPath);
    return undefined;
  }
  if (entry.id === undefined) return undefined;
  if (entry.mode !== FILE_MODE.GITLINK) {
    const blob = await readBlob(ctx, entry.id as IndexEntry['id']);
    await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);
  } else {
    await writeWorkingTreeEntry(ctx, entry.path, new Uint8Array(), entry.mode);
  }
  return buildIndexEntry(ctx, absPath, entry.path, entry.id, entry.mode);
};

export const applyChangeset = async (
  ctx: Context,
  opts: ApplyChangesetOpts,
): Promise<ApplyChangesetResult> => {
  const { changeset, force, workdir } = opts;

  if (!force) {
    const dirty = await checkDirty(ctx, workdir, changeset);
    if (dirty.localChanges.length > 0 || dirty.untracked.length > 0) {
      throw checkoutOverwriteDirty(dirty);
    }
  }

  const writtenEntries: IndexEntry[] = [];
  let written = 0;
  let deleted = 0;

  for (const entry of changeset.entries) {
    const indexEntry = await applyEntry(ctx, workdir, entry);
    if (entry.kind === 'delete') {
      deleted += 1;
    } else if (entry.kind === 'add' || entry.kind === 'update') {
      written += 1;
      if (indexEntry !== undefined) writtenEntries.push(indexEntry);
    }
    if (entry.kind !== 'noop') {
      ctx.progress.update(
        CHECKOUT_OP,
        written + deleted,
        changeset.stats.add + changeset.stats.update + changeset.stats.delete,
        entry.path,
      );
    }
  }

  return { writtenEntries, written, deleted };
};

/**
 * Apply a Changeset to the working tree + return new IndexEntry records.
 *
 * Lifecycle:
 *   1. Dirty-tree guard (unless `force`): hash any working-tree file that
 *      `update`/`delete` would touch and compare against the changeset's
 *      `previousId`. Untracked paths that `add` would clobber are also
 *      flagged. Collected paths surface as CHECKOUT_OVERWRITE_DIRTY.
 *   2. Apply each non-noop entry — `delete` then `add`/`update` per path,
 *      with per-file progress ticks.
 *   3. Build new stage-0 IndexEntry records from the post-write lstat.
 *
 * Atomicity: per-file (matches canonical git). No cross-file rollback —
 * see ADR-018.
 */
import { checkoutOverwriteDirty } from '../../domain/commands/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { FILE_MODE, type FileMode, type FilePath } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { Changeset, ChangesetEntry } from './compute-changeset.js';
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
const MODE_REGULAR_PERM = 0o644;
const MODE_EXEC_PERM = 0o755;

const decoder = new TextDecoder();

const joinPath = (workdir: string, rel: FilePath): string =>
  workdir.endsWith('/') ? `${workdir}${rel}` : `${workdir}/${rel}`;

const blobMatches = async (ctx: Context, absPath: string, expectedId: string): Promise<boolean> => {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(absPath);
  } catch {
    // File missing or unreadable — for a `delete`/`update` target this is
    // ambiguous (already deleted? race?). Treat as non-dirty; the apply
    // step will hit the same FS state and either succeed (rm of missing
    // file) or fail with an actionable error.
    return true;
  }
  // Compute the loose-object content hash with the `blob <size>\0` header
  // so it matches what git stored.
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const combined = new Uint8Array(header.length + bytes.length);
  combined.set(header, 0);
  combined.set(bytes, header.length);
  const id = await ctx.hash.hashHex(combined);
  return id === expectedId;
};

const isTrackedDirty = async (
  ctx: Context,
  absPath: string,
  expected: string,
): Promise<boolean> => {
  if (!(await ctx.fs.exists(absPath))) return false;
  return !(await blobMatches(ctx, absPath, expected));
};

const isUntrackedClash = async (ctx: Context, absPath: string): Promise<boolean> =>
  ctx.fs.exists(absPath);

const evaluateDirtyPath = async (
  ctx: Context,
  workdir: string,
  entry: ChangesetEntry,
): Promise<FilePath | undefined> => {
  const absPath = joinPath(workdir, entry.path);
  if (entry.kind === 'update' || entry.kind === 'delete') {
    if (entry.previousId === undefined) return undefined;
    return (await isTrackedDirty(ctx, absPath, entry.previousId)) ? entry.path : undefined;
  }
  if (entry.kind === 'add') {
    return (await isUntrackedClash(ctx, absPath)) ? entry.path : undefined;
  }
  return undefined;
};

const checkDirty = async (
  ctx: Context,
  workdir: string,
  changeset: Changeset,
): Promise<ReadonlyArray<FilePath>> => {
  const dirty: FilePath[] = [];
  for (const entry of changeset.entries) {
    const offending = await evaluateDirtyPath(ctx, workdir, entry);
    if (offending !== undefined) dirty.push(offending);
  }
  return dirty;
};

const writeFileEntry = async (
  ctx: Context,
  absPath: string,
  content: Uint8Array,
  mode: FileMode,
): Promise<void> => {
  if (mode === FILE_MODE.SYMLINK) {
    const target = decoder.decode(content);
    // Symlinks are written atomically by the platform; if a previous file
    // exists at the path, rm first.
    if (await ctx.fs.exists(absPath)) await ctx.fs.rm(absPath);
    await ctx.fs.symlink(target, absPath);
    return;
  }
  if (mode === FILE_MODE.GITLINK) {
    await ctx.fs.mkdir(absPath);
    return;
  }
  await ctx.fs.write(absPath, content);
  await ctx.fs.chmod(absPath, mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM);
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
    flags: { assumeValid: false, extended: false, stage: 0 },
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
    if (await ctx.fs.exists(absPath)) await ctx.fs.rm(absPath);
    return undefined;
  }
  if (entry.id === undefined) return undefined;
  if (entry.mode !== FILE_MODE.GITLINK) {
    const blob = await readBlob(ctx, entry.id as IndexEntry['id']);
    await writeFileEntry(ctx, absPath, blob.content, entry.mode);
  } else {
    await writeFileEntry(ctx, absPath, new Uint8Array(), entry.mode);
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
    if (dirty.length > 0) throw checkoutOverwriteDirty(dirty);
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

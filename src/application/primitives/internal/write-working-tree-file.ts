/**
 * Primitive-layer working-tree file writers/remover. Writing creates parent
 * directories; removing is a no-op when the file is already absent. The
 * low-level `writeRegularFile` always unlinks an occupant before a regular
 * write; the mode-aware `writeWorkingTreeEntry` dispatches symlink / gitlink /
 * regular on top of it. Shared by checkout's changeset application and the
 * three-way merge → working-tree application.
 */
import { FILE_MODE, type FileMode, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

const decoder = new TextDecoder();

const MODE_REGULAR_PERM = 0o644;
const MODE_EXEC_PERM = 0o755;

/**
 * Remove a working-tree path if it exists, probing with `lstat` (no symlink
 * follow) so dangling symlinks are detected and removed. Only the existence
 * probe may swallow an error (missing path); a failing `rm` propagates.
 */
export const rmIfExists = async (ctx: Context, fullPath: string): Promise<void> => {
  const exists = await ctx.fs
    .lstat(fullPath)
    .then(() => true)
    .catch(() => false);
  if (exists) await ctx.fs.rm(fullPath);
};

/**
 * The parent directory of an absolute path, or `undefined` when there is none
 * to create (no slash, or a root-level path like `/foo`). Exported for direct
 * unit testing of the boundary.
 */
export const parentDir = (fullPath: string): string | undefined => {
  const lastSlash = fullPath.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  return fullPath.slice(0, lastSlash);
};

/** Create the parent directory of an absolute path when there is one. */
export const ensureParent = async (ctx: Context, fullPath: string): Promise<void> => {
  const parent = parentDir(fullPath);
  if (parent !== undefined) await ctx.fs.mkdir(parent);
};

/**
 * Join a working-tree-relative path onto the work directory, collapsing a
 * trailing slash so the result is byte-identical regardless of how `workDir`
 * is configured (the single definition shared with `apply-changeset`).
 */
export const joinPath = (workDir: string, path: FilePath): string =>
  workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}`;

/**
 * Low-level regular-file writer and the single owner of the
 * unlink-before-regular-write rule: it `rmIfExists` unconditionally before the
 * write so a kind change (symlink → file) self-heals and the memory adapter
 * never keeps a stale symlink entry. `chmod` runs only when a `mode` is given.
 */
export const writeRegularFile = async (
  ctx: Context,
  fullPath: string,
  content: Uint8Array,
  mode?: FileMode,
): Promise<void> => {
  await ensureParent(ctx, fullPath);
  await rmIfExists(ctx, fullPath);
  await ctx.fs.write(fullPath, content);
  if (mode !== undefined) {
    await ctx.fs.chmod(
      fullPath,
      mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM,
    );
  }
};

export const writeWorkingTreeFile = async (
  ctx: Context,
  path: FilePath,
  content: Uint8Array,
): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  const parent = parentDir(fullPath);
  if (parent !== undefined) await ctx.fs.mkdir(parent);
  await ctx.fs.write(fullPath, content);
};

/**
 * Mode-aware working-tree write dispatching on `FileMode`: symlink (120000) →
 * create a symlink whose target is the blob content decoded as UTF-8 (rm-if-exists
 * first); gitlink (160000) → create the submodule directory (only checkout feeds
 * this arm); regular modes → delegate to `writeRegularFile`, which always unlinks
 * an occupant first so a kind change self-heals. Exported for the merge conflict
 * materialisation step and checkout's changeset application.
 */
export const writeWorkingTreeEntry = async (
  ctx: Context,
  path: FilePath,
  content: Uint8Array,
  mode: FileMode,
): Promise<void> => {
  const fullPath = joinPath(ctx.layout.workDir, path);
  if (mode === FILE_MODE.SYMLINK) {
    await ensureParent(ctx, fullPath);
    await rmIfExists(ctx, fullPath);
    await ctx.fs.symlink(decoder.decode(content), fullPath);
    return;
  }
  if (mode === FILE_MODE.GITLINK) {
    await ensureParent(ctx, fullPath);
    await ctx.fs.mkdir(fullPath);
    return;
  }
  await writeRegularFile(ctx, fullPath, content, mode);
};

export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  await rmIfExists(ctx, fullPath);
};

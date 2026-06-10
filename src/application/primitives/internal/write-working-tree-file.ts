/**
 * Primitive-layer working-tree file writer/remover. Writing creates parent
 * directories; removing is a no-op when the file is already absent. Used by the
 * three-way merge → working-tree application (`apply-merge-to-worktree`).
 */
import { FILE_MODE, type FileMode, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

const decoder = new TextDecoder();

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
 * Mode-aware working-tree write: symlink mode (120000) → create a symlink whose
 * target is the blob content decoded as UTF-8 (rm-if-exists first, mirroring
 * `apply-changeset`'s `writeFileEntry`); regular modes → plain file write.
 * Exported for use by the merge conflict materialisation step.
 */
export const writeWorkingTreeEntry = async (
  ctx: Context,
  path: FilePath,
  content: Uint8Array,
  mode: FileMode,
): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  const parent = parentDir(fullPath);
  if (parent !== undefined) await ctx.fs.mkdir(parent);
  if (mode === FILE_MODE.SYMLINK) {
    const target = decoder.decode(content);
    await rmIfExists(ctx, fullPath);
    await ctx.fs.symlink(target, fullPath);
    return;
  }
  await ctx.fs.write(fullPath, content);
};

export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  await rmIfExists(ctx, fullPath);
};

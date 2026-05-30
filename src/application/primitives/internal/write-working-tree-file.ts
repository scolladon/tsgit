/**
 * Primitive-layer working-tree file writer/remover. Writing creates parent
 * directories; removing is a no-op when the file is already absent. Used by the
 * three-way merge → working-tree application (`apply-merge-to-worktree`).
 */
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';

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

export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  if (await ctx.fs.exists(fullPath)) await ctx.fs.rm(fullPath);
};

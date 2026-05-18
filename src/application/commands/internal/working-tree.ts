import { checkoutOverwriteDirty } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { unsupportedOperation } from '../../../domain/index.js';
import type { FileMode } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  isForbiddenGitComponent,
  validateWorkingTreePath,
} from '../../../domain/working-tree-path.js';
import type { Context } from '../../../ports/context.js';

export { isForbiddenGitComponent };

/**
 * Validate a working-tree path. Throws `PATHSPEC_OUTSIDE_REPO` for any policy
 * violation. Returns the input as a `FilePath` brand on success.
 *
 * Delegated to `src/domain/working-tree-path.ts` so primitives can share the
 * exact same policy without depending on `application/commands/` (see
 * `.dependency-cruiser.cjs` rule `primitives-cannot-import-commands`).
 */
export const validatePath = validateWorkingTreePath;

const repoPath = (ctx: Context, path: FilePath): string => `${ctx.layout.workDir}/${path}`;

/**
 * Materialize a blob into the working tree at `path` with the given mode.
 *
 * - `100644` (regular): write file.
 * - `100755` (executable): write file then `chmod 0o755` where supported.
 * - `120000` (symlink): on platforms without symlink support (memory/OPFS),
 *   writes the link target as the file's bytes — byte-exact, no newline added.
 * - `160000` (gitlink/submodule): throws `UNSUPPORTED_OPERATION` (v1).
 */
export const materializeFile = async (
  ctx: Context,
  rawPath: string,
  blob: Uint8Array,
  mode: FileMode,
): Promise<void> => {
  const path = validatePath(rawPath);
  if (mode === '160000') {
    throw unsupportedOperation('materializeFile', 'gitlink (submodule) not supported in v1');
  }
  if (mode === '40000') {
    // Tree mode is not a leaf; callers should never reach here.
    throw unsupportedOperation('materializeFile', 'directory mode is not a leaf');
  }
  const dst = repoPath(ctx, path);
  // Symlink-safe write: ensure the file exists, then open with O_NOFOLLOW so
  // a TOCTOU symlink swap of the leaf is detected and rejected. On adapters
  // without O_NOFOLLOW (browser OPFS) the openWithNoFollow throws
  // UNSUPPORTED_OPERATION; we fall back to plain write since OPFS has no
  // symlinks to begin with.
  await ctx.fs.write(dst, new Uint8Array());
  let handle: Awaited<ReturnType<Context['fs']['openWithNoFollow']>> | undefined;
  try {
    handle = await ctx.fs.openWithNoFollow(dst, 'write');
    await handle.write(blob);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'UNSUPPORTED_OPERATION') {
      await ctx.fs.write(dst, blob);
    } else {
      throw err;
    }
  } finally {
    await handle?.close();
  }
  if (mode === '100755') {
    await ctx.fs.chmod(dst, 0o755);
  } else if (mode === '100644') {
    await ctx.fs.chmod(dst, 0o644);
  }
};

/**
 * Read the working-tree file at `path`. Validates the path first.
 */
export const readFile = async (ctx: Context, rawPath: string): Promise<Uint8Array> => {
  const path = validatePath(rawPath);
  return ctx.fs.read(repoPath(ctx, path));
};

/**
 * Remove the working-tree file at `path`. Refuses to remove a directory or a
 * missing file (both treated as a divergence from what we expected to be there).
 * Throws `CHECKOUT_OVERWRITE_DIRTY` rather than blindly mutating.
 */
export const removeFile = async (ctx: Context, rawPath: string): Promise<void> => {
  const path = validatePath(rawPath);
  const full = repoPath(ctx, path);
  let stat: Awaited<ReturnType<Context['fs']['lstat']>>;
  try {
    stat = await ctx.fs.lstat(full);
  } catch {
    throw checkoutOverwriteDirty([path]);
  }
  if (!stat.isFile && !stat.isSymbolicLink) {
    throw checkoutOverwriteDirty([path]);
  }
  await ctx.fs.rm(full);
};

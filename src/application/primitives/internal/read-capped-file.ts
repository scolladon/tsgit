import { TsgitError } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';

/**
 * Expand a `~`/`~/…` config-driven path against `layout.homeDir`. Returns the
 * raw path unchanged when it is not home-relative, or `undefined` when home
 * expansion is needed but no home directory is known. Shared by the
 * `.gitignore` (`core.excludesFile`) and `.gitattributes` (`core.attributesFile`)
 * global-file loaders.
 */
export const expandUserPath = (ctx: Context, raw: string): string | undefined => {
  if (raw === '~') return ctx.layout.homeDir;
  if (raw.startsWith('~/')) {
    // Stryker disable next-line ConditionalExpression: equivalent — dropping the guard templates `"undefined/<rest>"`; that path always fails `lstat` with FILE_NOT_FOUND and the loader catches it and returns `undefined`, identical to the explicit guard.
    if (ctx.layout.homeDir === undefined) return undefined;
    return `${ctx.layout.homeDir}/${raw.slice(2)}`;
  }
  return raw;
};

/**
 * Strip the directory prefix from a path before embedding it in an error
 * payload. For config-driven paths (which can resolve to an arbitrary absolute
 * path outside the repo), this keeps the error from leaking the user's
 * home-directory layout to upstream observers.
 */
export const sanitizedErrorPath = (path: string): FilePath => {
  const slash = path.lastIndexOf('/');
  return (slash === -1 ? path : path.slice(slash + 1)) as FilePath;
};

/**
 * Bounded read of a per-directory / config-driven text file (`.gitignore`,
 * `.gitattributes`, their `info/` and global variants). Returns `undefined`
 * when the file is absent, a symlink, or not a regular file; throws the
 * caller's `tooLarge` error when it exceeds `limit`. The caller parses the
 * returned text.
 */
export const loadCappedUtf8 = async (
  ctx: Context,
  path: string,
  limit: number,
  tooLarge: (path: FilePath, size: number, limit: number) => TsgitError,
): Promise<string | undefined> => {
  let stat: Awaited<ReturnType<Context['fs']['lstat']>>;
  try {
    stat = await ctx.fs.lstat(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
  if (!stat.isFile || stat.isSymbolicLink) return undefined;
  if (stat.size > limit) {
    throw tooLarge(sanitizedErrorPath(path), stat.size, limit);
  }
  return ctx.fs.readUtf8(path);
};

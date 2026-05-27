import { gitignoreFileTooLarge } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { type IgnoreRuleset, parseGitignore } from '../../../domain/ignore/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { MAX_GITIGNORE_BYTES } from '../types.js';

/**
 * Load and parse the `.gitignore` file in a directory relative to the
 * working tree. `dir === ''` targets the repo root. Returns `undefined`
 * when the file does not exist (the common case for most directories).
 */
export const readGitignore = async (
  ctx: Context,
  dir: FilePath | '',
): Promise<IgnoreRuleset | undefined> => {
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — the false branch yields `${workDir}//.gitignore`; node + memory FS path normalisation collapse the empty segment, so the file resolves to the identical location.
  const path =
    dir === '' ? `${ctx.layout.workDir}/.gitignore` : `${ctx.layout.workDir}/${dir}/.gitignore`;
  return loadAndParse(ctx, path);
};

/** Load `.git/info/exclude` (per-clone excludes that don't ship with the repo). */
export const readInfoExclude = async (ctx: Context): Promise<IgnoreRuleset | undefined> =>
  loadAndParse(ctx, `${ctx.layout.gitDir}/info/exclude`);

/**
 * Load the global excludes file pointed at by `core.excludesFile` in
 * the repo's config. Returns `undefined` when:
 * - the config key is unset,
 * - the path starts with `~/` but `ctx.layout.homeDir` is undefined
 *  (silent miss),
 * - or the file does not exist.
 */
export const readGlobalExcludes = async (ctx: Context): Promise<IgnoreRuleset | undefined> => {
  const config = await readConfig(ctx);
  const raw = config.core?.excludesFile;
  if (raw === undefined) return undefined;
  const resolved = expandUserPath(ctx, raw);
  if (resolved === undefined) return undefined;
  return loadAndParse(ctx, resolved);
};

const expandUserPath = (ctx: Context, raw: string): string | undefined => {
  if (raw === '~') return ctx.layout.homeDir;
  if (raw.startsWith('~/')) {
    // Stryker disable next-line ConditionalExpression: equivalent — dropping the guard templates `"undefined/<rest>"`; that path always fails `lstat` with FILE_NOT_FOUND and the loader catches it and returns `undefined`, identical to the explicit guard.
    if (ctx.layout.homeDir === undefined) return undefined;
    return `${ctx.layout.homeDir}/${raw.slice(2)}`;
  }
  return raw;
};

const loadAndParse = async (ctx: Context, path: string): Promise<IgnoreRuleset | undefined> => {
  let stat: Awaited<ReturnType<Context['fs']['lstat']>>;
  try {
    stat = await ctx.fs.lstat(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
  if (!stat.isFile || stat.isSymbolicLink) return undefined;
  if (stat.size > MAX_GITIGNORE_BYTES) {
    throw gitignoreFileTooLarge(sanitizedErrorPath(path), stat.size, MAX_GITIGNORE_BYTES);
  }
  const text = await ctx.fs.readUtf8(path);
  return parseGitignore(text);
};

/**
 * Strip the directory prefix from a path before embedding it in an
 * error payload. For `core.excludesFile` (which can resolve to an
 * arbitrary absolute path outside the repo), this keeps the error
 * from leaking the user's home-directory layout to upstream observers.
 */
const sanitizedErrorPath = (path: string): FilePath => {
  const slash = path.lastIndexOf('/');
  return (slash === -1 ? path : path.slice(slash + 1)) as FilePath;
};

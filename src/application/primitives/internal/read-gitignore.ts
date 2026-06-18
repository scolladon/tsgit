import { gitignoreFileTooLarge } from '../../../domain/commands/error.js';
import { type IgnoreRuleset, parseGitignore } from '../../../domain/ignore/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { commonGitDir } from '../path-layout.js';
import { MAX_GITIGNORE_BYTES } from '../types.js';
import { joinPath } from './join-working-tree-path.js';
import { expandUserPath, loadCappedUtf8 } from './read-capped-file.js';

/**
 * Load and parse the `.gitignore` file in a directory relative to the
 * working tree. `dir === ''` targets the repo root. Returns `undefined`
 * when the file does not exist (the common case for most directories).
 */
export const readGitignore = async (
  ctx: Context,
  dir: FilePath | '',
): Promise<IgnoreRuleset | undefined> => {
  const path = joinPath(ctx.layout.workDir, dir === '' ? '.gitignore' : `${dir}/.gitignore`);
  return loadAndParse(ctx, path);
};

/** Load `.git/info/exclude` (per-clone excludes that don't ship with the repo). */
export const readInfoExclude = async (ctx: Context): Promise<IgnoreRuleset | undefined> =>
  loadAndParse(ctx, `${commonGitDir(ctx)}/info/exclude`);

/**
 * Load the global excludes file pointed at by `core.excludesFile` in
 * the repo's config. Returns `undefined` when:
 * - the config key is unset or empty (feature-off, matching git),
 * - the path starts with `~/` but `ctx.layout.homeDir` is undefined
 *  (silent miss),
 * - or the file does not exist.
 */
export const readGlobalExcludes = async (ctx: Context): Promise<IgnoreRuleset | undefined> => {
  const config = await readConfig(ctx);
  const raw = config.core?.excludesFile;
  if (raw === undefined || raw === '') return undefined;
  const resolved = expandUserPath(ctx, raw);
  if (resolved === undefined) return undefined;
  return loadAndParse(ctx, resolved);
};

const loadAndParse = async (ctx: Context, path: string): Promise<IgnoreRuleset | undefined> => {
  const text = await loadCappedUtf8(ctx, path, MAX_GITIGNORE_BYTES, gitignoreFileTooLarge);
  return text === undefined ? undefined : parseGitignore(text);
};

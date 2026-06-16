import {
  type AttributeSource,
  buildMacroRegistry,
  type MacroRegistry,
  type ParsedAttributes,
  parseGitattributes,
} from '../../../domain/attributes/index.js';
import { gitattributesFileTooLarge } from '../../../domain/commands/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { commonGitDir } from '../path-layout.js';
import { MAX_GITATTRIBUTES_BYTES } from '../types.js';
import { expandUserPath, loadCappedUtf8 } from './read-capped-file.js';

/** Load + parse one attributes file; `undefined` when absent, symlink, or a directory. */
const loadAndParse = async (ctx: Context, path: string): Promise<ParsedAttributes | undefined> => {
  const text = await loadCappedUtf8(ctx, path, MAX_GITATTRIBUTES_BYTES, gitattributesFileTooLarge);
  return text === undefined ? undefined : parseGitattributes(text);
};

const readDir = (ctx: Context, dir: FilePath | ''): Promise<ParsedAttributes | undefined> =>
  loadAndParse(
    ctx,
    dir === ''
      ? `${ctx.layout.workDir}/.gitattributes`
      : `${ctx.layout.workDir}/${dir}/.gitattributes`,
  );

const readInfo = (ctx: Context): Promise<ParsedAttributes | undefined> =>
  loadAndParse(ctx, `${commonGitDir(ctx)}/info/attributes`);

/**
 * Load the global attributes file pointed at by `core.attributesFile`.
 * An unset or empty-string value is feature-off (matching git — an empty
 * path-like is never resolved as a path), so the global source is absent.
 */
const readGlobal = async (ctx: Context): Promise<ParsedAttributes | undefined> => {
  const raw = (await readConfig(ctx)).core?.attributesFile;
  if (raw === undefined || raw === '') return undefined;
  const resolved = expandUserPath(ctx, raw);
  if (resolved === undefined) return undefined;
  return loadAndParse(ctx, resolved);
};

/** Directories whose `.gitattributes` govern `path`, deepest first, root (`''`) last. */
const dirChain = (path: FilePath): ReadonlyArray<string> => {
  const parts = path.split('/');
  parts.pop(); // drop the filename
  const dirs: string[] = [];
  for (let i = parts.length; i >= 1; i -= 1) dirs.push(parts.slice(0, i).join('/'));
  dirs.push('');
  return dirs;
};

/** Resolves the precedence-ordered attribute sources + macro registry for a path. */
export interface AttributeProvider {
  readonly sourcesForPath: (path: FilePath) => Promise<{
    readonly sources: ReadonlyArray<AttributeSource>;
    readonly macros: MacroRegistry;
  }>;
}

/**
 * Build an `AttributeProvider` for a context. `info/attributes`, the global
 * `core.attributesFile`, and the root `.gitattributes` are read once; macros
 * (built-in + those three files) are assembled once. Per-path lookups stack the
 * sources highest→lowest precedence — `info/attributes`, then each directory
 * from the path's own up to the root, then global — loading and caching each
 * directory's `.gitattributes` on demand.
 */
export const buildAttributeProvider = async (ctx: Context): Promise<AttributeProvider> => {
  const info = await readInfo(ctx);
  const global = await readGlobal(ctx);
  const root = await readDir(ctx, '');
  const macros = buildMacroRegistry([
    ...(info?.macros ?? []),
    ...(root?.macros ?? []),
    ...(global?.macros ?? []),
  ]);
  const dirCache = new Map<string, ParsedAttributes | undefined>([['', root]]);
  const loadDir = async (dir: string): Promise<ParsedAttributes | undefined> => {
    if (dirCache.has(dir)) return dirCache.get(dir);
    const parsed = await readDir(ctx, dir as FilePath);
    dirCache.set(dir, parsed);
    return parsed;
  };
  const sourcesForPath = async (
    path: FilePath,
  ): Promise<{ sources: ReadonlyArray<AttributeSource>; macros: MacroRegistry }> => {
    const sources: AttributeSource[] = [];
    if (info !== undefined) sources.push({ basedir: '', rules: info.rules });
    for (const dir of dirChain(path)) {
      const parsed = await loadDir(dir);
      if (parsed !== undefined) sources.push({ basedir: dir, rules: parsed.rules });
    }
    if (global !== undefined) sources.push({ basedir: '', rules: global.rules });
    return { sources, macros };
  };
  return { sourcesForPath };
};

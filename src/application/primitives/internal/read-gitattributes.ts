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
import { joinPath } from './join-working-tree-path.js';
import { expandUserPath, loadCappedUtf8 } from './read-capped-file.js';
import { requireWorkTree } from './repo-state.js';

/** Load + parse one attributes file; `undefined` when absent, symlink, or a directory. */
const loadAndParse = async (ctx: Context, path: string): Promise<ParsedAttributes | undefined> => {
  const text = await loadCappedUtf8(ctx, path, MAX_GITATTRIBUTES_BYTES, gitattributesFileTooLarge);
  return text === undefined ? undefined : parseGitattributes(text);
};

const readDir = (ctx: Context, dir: FilePath | ''): Promise<ParsedAttributes | undefined> =>
  loadAndParse(
    ctx,
    joinPath(
      requireWorkTree(ctx, 'buildAttributeProvider'),
      dir === '' ? '.gitattributes' : `${dir}/.gitattributes`,
    ),
  );

const readInfo = (ctx: Context): Promise<ParsedAttributes | undefined> =>
  loadAndParse(ctx, `${commonGitDir(ctx)}/info/attributes`);

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

/**
 * True when `segment` is `..`, or Win32 path canonicalisation reduces it to
 * `..` by stripping trailing dots/spaces (e.g. `'.. '`, `'...'`) — a
 * `CreateFile`/`GetFullPathName`-style traversal segment a naive `=== '..'`
 * check would miss.
 */
const isDotDotSegment = (segment: string): boolean =>
  // Stryker disable next-line MethodExpression: equivalent — reached only when segment.startsWith('..') already holds, so the class trivially matches the leading two dots; testing the whole segment is identical to testing the remainder.
  segment === '..' || (segment.startsWith('..') && /^[. ]*$/.test(segment.slice(2)));

const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:/;

/**
 * True when a directory chain entry — built from a diff-change path the raw
 * merge-join never validates — would lexically resolve outside the worktree
 * once joined onto `workDir`: a leading absolute segment (POSIX `/` or a
 * Windows drive letter), or a `..` (or Win32-canonicalises-to-`..`) segment.
 * Real git diffs such trees cleanly; this is the boundary that lets tsgit do
 * the same without ever asking the filesystem about a path outside the
 * worktree. Never called with `''` — the root directory key is pre-seeded
 * into `dirCache` before any lookup, so `loadDir` never reaches this guard
 * for it.
 */
const dirEscapesWorktree = (dir: string): boolean => {
  const normalized = dir.replace(/\\/g, '/');
  if (normalized.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE_RE.test(normalized)) return true;
  // Stryker disable next-line StringLiteral: equivalent — a genuine dot-dot segment always contains '..', so normalized.includes('..') is implied whenever .some(isDotDotSegment) is true; forcing it always-true cannot change the && result.
  return normalized.includes('..') && normalized.split('/').some(isDotDotSegment);
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
    if (dirEscapesWorktree(dir)) {
      dirCache.set(dir, undefined);
      return undefined;
    }
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

export const maybeBuildAttributeProvider = (
  ctx: Context,
): Promise<AttributeProvider | undefined> =>
  ctx.command !== undefined ? buildAttributeProvider(ctx) : Promise.resolve(undefined);

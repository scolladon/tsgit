import {
  type AttributeSource,
  buildMacroRegistry,
  type MacroRegistry,
  type ParsedAttributes,
  parseGitattributes,
} from '../../../domain/attributes/index.js';
import { gitattributesFileTooLarge } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { decode } from '../../../domain/objects/encoding.js';
import { FILE_MODE, isDirectory } from '../../../domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { commonGitDir } from '../path-layout.js';
import { readBlob } from '../read-blob.js';
import { readIndex } from '../read-index.js';
import { readDeclaredObjectHeader } from '../read-object.js';
import { MAX_GITATTRIBUTES_BYTES } from '../types.js';
import { joinPath } from './join-working-tree-path.js';
import { expandUserPath, loadCappedUtf8 } from './read-capped-file.js';
import { findTreeEntry } from './resolve-tree-path.js';

/** Load + parse one attributes file; `undefined` when absent, symlink, or a directory. */
const loadAndParse = async (ctx: Context, path: string): Promise<ParsedAttributes | undefined> => {
  const text = await loadCappedUtf8(ctx, path, MAX_GITATTRIBUTES_BYTES, gitattributesFileTooLarge);
  return text === undefined ? undefined : parseGitattributes(text);
};

/**
 * Bare repositories (no work tree, `attr.tree` unset) read no work-tree or
 * HEAD-tree `.gitattributes` at all — verified against real git 2.55: a
 * committed root `.gitattributes` resolves `unspecified` in a bare clone
 * unless `attr.tree`/`--attr-source` names a tree explicitly, which tsgit
 * does not yet support. `info/attributes` and `core.attributesFile` are
 * unaffected — neither lives in the work tree — so only this source is
 * skipped, never the whole provider.
 */
const workTreeDirReader: DirReader = (ctx, dir) => {
  const workDir = ctx.layout.workDir;
  if (workDir === undefined) return Promise.resolve(undefined);
  return loadAndParse(
    ctx,
    joinPath(workDir, dir === '' ? '.gitattributes' : `${dir}/.gitattributes`),
  );
};

type DirReader = (ctx: Context, dir: FilePath | '') => Promise<ParsedAttributes | undefined>;

const GITATTRIBUTES_FILE = '.gitattributes';

/** Symlink-mode entries are never read (git refuses to follow them for attributes). */
const isReadableMode = (mode: string): boolean =>
  mode === FILE_MODE.REGULAR || mode === FILE_MODE.EXECUTABLE;

/** Refuses on the header's claim so a hostile tree never allocates an oversize blob. */
const assertDeclaredSizeWithinCap = async (ctx: Context, id: ObjectId): Promise<void> => {
  const { declaredSize } = await readDeclaredObjectHeader(ctx, id);
  if (declaredSize > MAX_GITATTRIBUTES_BYTES) {
    throw gitattributesFileTooLarge(
      GITATTRIBUTES_FILE as FilePath,
      declaredSize,
      MAX_GITATTRIBUTES_BYTES,
    );
  }
};

const NO_SEPARATOR = -1;

/** The directory holding `path`: `a/b/c` → `a/b`, a top-level name → the root `''`. */
const parentDir = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === NO_SEPARATOR ? '' : path.slice(0, slash);
};

const DIRECTORY_MARKER = '/';

/** The directory a queried path sits in — a `dir/` key names `dir` inside its parent. */
const containingDir = (path: string): string =>
  parentDir(path.endsWith(DIRECTORY_MARKER) ? path.slice(0, -DIRECTORY_MARKER.length) : path);

/**
 * Each directory's tree, found by one exact-name lookup in its parent's tree,
 * so a walk-ordered lookup reads one level per directory instead of
 * re-descending from the root. Only an exact descent is cached — a directory
 * reached any other way is left to the root descent, which owns the
 * prefix-boundary fallback.
 */
// Pending lookups are cached too, so concurrent lookups of one directory share a read.
const createDirTreeIndex = (tree: ObjectId) => {
  const dirTrees = new Map<string, Promise<ObjectId | undefined>>([['', Promise.resolve(tree)]]);
  const lookUp = async (ctx: Context, dir: string): Promise<ObjectId | undefined> => {
    const parent = await dirTrees.get(parentDir(dir));
    if (parent === undefined) return undefined;
    const entry = await findTreeEntry(ctx, parent, dir.slice(dir.lastIndexOf('/') + 1));
    return entry !== undefined && isDirectory(entry.mode) ? entry.id : undefined;
  };
  return (ctx: Context, dir: string): Promise<ObjectId | undefined> => {
    const cached = dirTrees.get(dir);
    if (cached !== undefined) return cached;
    const pending = lookUp(ctx, dir);
    dirTrees.set(dir, pending);
    return pending;
  };
};

/** Reads a `.gitattributes` blob under the same size guard whichever store named it. */
const parseBlobAttributes = async (ctx: Context, id: ObjectId): Promise<ParsedAttributes> => {
  await assertDeclaredSizeWithinCap(ctx, id);
  const { content } = await readBlob(ctx, id);
  return parseGitattributes(decode(content));
};

const treeDirReader = (tree: ObjectId): DirReader => {
  const dirTreeOf = createDirTreeIndex(tree);
  return async (ctx, dir) => {
    const dirTree = await dirTreeOf(ctx, dir);
    const entry = await (dirTree === undefined
      ? findTreeEntry(ctx, tree, `${dir}/${GITATTRIBUTES_FILE}`)
      : findTreeEntry(ctx, dirTree, GITATTRIBUTES_FILE));
    if (entry === undefined || !isReadableMode(entry.mode)) return undefined;
    return parseBlobAttributes(ctx, entry.id);
  };
};

/** The blob id the index records for a path, when it records one. */
export type IndexBlobLookup = (path: FilePath) => ObjectId | undefined;

/** Which store a provider reads each directory's `.gitattributes` from, and in what order. */
export type AttributeDirection =
  | { readonly kind: 'worktree-first'; readonly index: IndexBlobLookup }
  | { readonly kind: 'index-first'; readonly index: IndexBlobLookup }
  | { readonly kind: 'index-only'; readonly index: IndexBlobLookup }
  | { readonly kind: 'tree'; readonly tree: ObjectId };

const indexDirReader =
  (lookup: IndexBlobLookup): DirReader =>
  async (ctx, dir) => {
    const id = lookup(
      (dir === '' ? GITATTRIBUTES_FILE : `${dir}/${GITATTRIBUTES_FILE}`) as FilePath,
    );
    return id === undefined ? undefined : parseBlobAttributes(ctx, id);
  };

/** The fallback is consulted only when the primary store holds no such file. */
const firstOf =
  (primary: DirReader, fallback: DirReader): DirReader =>
  async (ctx, dir) =>
    (await primary(ctx, dir)) ?? fallback(ctx, dir);

const dirReaderFor = (direction: AttributeDirection | undefined): DirReader => {
  switch (direction?.kind) {
    case undefined:
      return workTreeDirReader;
    case 'worktree-first':
      return firstOf(workTreeDirReader, indexDirReader(direction.index));
    case 'index-first':
      return firstOf(indexDirReader(direction.index), workTreeDirReader);
    case 'index-only':
      return indexDirReader(direction.index);
    case 'tree':
      return treeDirReader(direction.tree);
  }
};

const readInfo = (ctx: Context): Promise<ParsedAttributes | undefined> =>
  loadAndParse(ctx, `${commonGitDir(ctx)}/info/attributes`);

const readGlobal = async (ctx: Context): Promise<ParsedAttributes | undefined> => {
  const raw = (await readConfig(ctx)).core?.attributesFile;
  if (raw === undefined || raw === '') return undefined;
  const resolved = expandUserPath(ctx, raw);
  if (resolved === undefined) return undefined;
  return loadAndParse(ctx, resolved);
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
 * worktree. Never called with `''` — the root's stack is pre-seeded before
 * any lookup, so no load ever reaches this guard for it.
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

type DirLoader = (dir: string) => Promise<ParsedAttributes | undefined>;

/**
 * Each directory's sources from its own `.gitattributes` up to the root's,
 * deepest first, built on its parent's stack so a walk-ordered lookup loads
 * and copies one level instead of re-deriving the whole chain. A fresh chain
 * still loads deepest first.
 */
const createDirectoryStacks = (
  loadDir: DirLoader,
  rootStack: ReadonlyArray<AttributeSource>,
): ((dir: string) => Promise<ReadonlyArray<AttributeSource>>) => {
  // Pending loads are cached too, so concurrent lookups under one directory share its read.
  const stacks = new Map<string, Promise<ReadonlyArray<AttributeSource>>>([
    ['', Promise.resolve(rootStack)],
  ]);
  const load = async (dir: string): Promise<ReadonlyArray<AttributeSource>> => {
    const parsed = await loadDir(dir);
    const above = await stackOf(parentDir(dir));
    return parsed === undefined ? above : [{ basedir: dir, rules: parsed.rules }, ...above];
  };
  const stackOf = (dir: string): Promise<ReadonlyArray<AttributeSource>> => {
    const cached = stacks.get(dir);
    if (cached !== undefined) return cached;
    const pending = load(dir);
    stacks.set(dir, pending);
    return pending;
  };
  return stackOf;
};

/**
 * Build an `AttributeProvider` for a context. `info/attributes`, the global
 * `core.attributesFile`, and the root `.gitattributes` are read once; macros
 * (built-in + those three files) are assembled once. Per-path lookups stack the
 * sources highest→lowest precedence — `info/attributes`, then each directory
 * from the path's own up to the root, then global — loading and caching each
 * directory's `.gitattributes` on demand.
 */
const buildAttributeProviderFrom = async (
  ctx: Context,
  readDir: DirReader,
): Promise<AttributeProvider> => {
  const info = await readInfo(ctx);
  const global = await readGlobal(ctx);
  const root = await readDir(ctx, '');
  const macros = buildMacroRegistry([info, root, global].flatMap((file) => file?.macros ?? []));
  const stackOf = createDirectoryStacks(
    (dir) => (dirEscapesWorktree(dir) ? Promise.resolve(undefined) : readDir(ctx, dir as FilePath)),
    rootSourceOf(root),
  );
  const highest = rootSourceOf(info);
  const lowest = rootSourceOf(global);
  const sourcesForPath = async (
    path: FilePath,
  ): Promise<{ sources: ReadonlyArray<AttributeSource>; macros: MacroRegistry }> => ({
    sources: [...highest, ...(await stackOf(containingDir(path))), ...lowest],
    macros,
  });
  return { sourcesForPath };
};

/** A file read at the top of the work tree, as the one source it contributes. */
const rootSourceOf = (file: ParsedAttributes | undefined): ReadonlyArray<AttributeSource> =>
  file === undefined ? [] : [{ basedir: '', rules: file.rules }];

export const buildAttributeProvider = (
  ctx: Context,
  direction?: AttributeDirection,
): Promise<AttributeProvider> => buildAttributeProviderFrom(ctx, dirReaderFor(direction));

/** The same three codes add treats as "no index yet", since it builds this provider before its own read. */
const INDEX_MISSING_CODES = new Set([
  'FILE_NOT_FOUND',
  'INVALID_INDEX_HEADER',
  'INVALID_INDEX_ENTRY',
]);

const isAttributesPath = (path: string): boolean =>
  path === GITATTRIBUTES_FILE || path.endsWith(`/${GITATTRIBUTES_FILE}`);

const readIndexAttributeBlobs = async (ctx: Context): Promise<ReadonlyMap<string, ObjectId>> => {
  try {
    const { entries } = await readIndex(ctx);
    return new Map(
      entries
        .filter((entry) => entry.flags.stage === 0 && isAttributesPath(entry.path))
        .map((entry) => [entry.path, entry.id]),
    );
  } catch (err) {
    if (err instanceof TsgitError && INDEX_MISSING_CODES.has(err.data.code)) return new Map();
    throw err;
  }
};

/** The check-in provider: work tree first, the index as git's fallback for files absent from disk. */
export const maybeBuildAttributeProvider = async (ctx: Context): Promise<AttributeProvider> => {
  const blobs = await readIndexAttributeBlobs(ctx);
  return buildAttributeProvider(ctx, {
    kind: 'worktree-first',
    index: (path) => blobs.get(path),
  });
};

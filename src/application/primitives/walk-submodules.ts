/**
 * Submodule walk — yields gitlink entries from a tree-ish, optionally
 * recursing into each nested submodule whose absorbed gitdir is locally
 * available. See `docs/design/submodule-walk.md` and ADRs 083–086.
 */
import { TsgitError } from '../../domain/error.js';
import {
  FILE_MODE,
  type FilePath,
  type ObjectId,
  RefName,
  type Tree,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { type IniSection, parseIniSections } from './config-read.js';
import { readBlob } from './read-blob.js';
import { readTree } from './read-tree.js';
import {
  MAX_GITMODULES_BYTES,
  MAX_SUBMODULE_DEPTH,
  type SubmoduleEntry,
  type WalkSubmodulesOptions,
} from './types.js';
import { walkTree } from './walk-tree.js';

const HEAD_REF = RefName.from('HEAD');

/** Reduction of one `[submodule "<name>"]` section to the keys this walk consumes. */
interface GitmodulesRow {
  readonly name: string;
  readonly path?: string;
  readonly url?: string;
  readonly branch?: string;
}

/**
 * Yield every gitlink reachable in `ref`'s tree, joined with its `.gitmodules`
 * metadata. With `recursive: true`, descend into each nested submodule whose
 * absorbed gitdir (`${gitDir}/modules/<name>`) is locally available; nested
 * yields carry `depth >= 1` and a `parent` path. Uninitialised / missing /
 * cyclic nested submodules contribute their own entry but no children — the
 * absence of further yields is the signal, matching `git submodule status
 * --recursive`.
 */
export async function* walkSubmodules(
  ctx: Context,
  options?: WalkSubmodulesOptions,
): AsyncIterable<SubmoduleEntry> {
  const ref = options?.ref ?? HEAD_REF;
  const recursive = options?.recursive === true;
  const rootTree = await readTree(ctx, ref);
  const visited = new Set<string>([ctx.layout.gitDir]);
  yield* walkInTree(ctx, rootTree, 0, undefined, '', visited, recursive);
}

async function* walkInTree(
  ctx: Context,
  tree: Tree,
  depth: number,
  parent: FilePath | undefined,
  pathPrefix: string,
  visited: Set<string>,
  recursive: boolean,
): AsyncIterable<SubmoduleEntry> {
  const rows = await readGitmodules(ctx, tree);
  for await (const entry of walkTree(ctx, tree, { recursive: true })) {
    if (entry.mode !== FILE_MODE.GITLINK) continue;
    const fullPath = joinPath(pathPrefix, entry.path) as FilePath;
    const row = rows.get(entry.path);
    yield buildEntry(row, entry.path, entry.id, fullPath, depth, parent);
    if (!recursive) continue;
    if (depth >= MAX_SUBMODULE_DEPTH) continue;
    const childCtx = await deriveChildContext(ctx, row?.name, entry.path, visited);
    if (childCtx === undefined) continue;
    const childTree = await tryReadTree(childCtx, entry.id);
    if (childTree === undefined) continue;
    const nextVisited = new Set(visited).add(childCtx.layout.gitDir);
    yield* walkInTree(childCtx, childTree, depth + 1, fullPath, fullPath, nextVisited, recursive);
  }
}

const buildEntry = (
  row: GitmodulesRow | undefined,
  treeRelPath: FilePath,
  commit: ObjectId,
  fullPath: FilePath,
  depth: number,
  parent: FilePath | undefined,
): SubmoduleEntry => ({
  name: row?.name ?? (treeRelPath as string),
  path: fullPath,
  commit,
  depth,
  ...(row?.url !== undefined ? { url: row.url } : {}),
  ...(row?.branch !== undefined ? { branch: row.branch } : {}),
  ...(parent !== undefined ? { parent } : {}),
});

const joinPath = (prefix: string, leaf: string): string =>
  prefix === '' ? leaf : `${prefix}/${leaf}`;

const readGitmodules = async (
  ctx: Context,
  tree: Tree,
): Promise<ReadonlyMap<string, GitmodulesRow>> => {
  const file = tree.entries.find((e) => e.name === '.gitmodules');
  if (file === undefined) return new Map();
  if (file.mode !== FILE_MODE.REGULAR && file.mode !== FILE_MODE.EXECUTABLE) return new Map();
  const blob = await readBlob(ctx, file.id, { maxBytes: MAX_GITMODULES_BYTES });
  const text = new TextDecoder().decode(blob.content);
  const rows = new Map<string, GitmodulesRow>();
  for (const section of parseIniSections(text)) {
    const row = reduceSection(section);
    if (row === undefined) continue;
    if (row.path === undefined) continue;
    rows.set(row.path, row);
  }
  return rows;
};

const reduceSection = (section: IniSection): GitmodulesRow | undefined => {
  if (section.section !== 'submodule') return undefined;
  if (section.subsection === undefined) return undefined;
  if (isUnsafeSubmoduleName(section.subsection)) return undefined;
  let path: string | undefined;
  let url: string | undefined;
  let branch: string | undefined;
  for (const { key, value } of section.entries) {
    const lowered = key.toLowerCase();
    if (lowered === 'path') path = value;
    else if (lowered === 'url') url = value;
    else if (lowered === 'branch') branch = value;
  }
  return {
    name: section.subsection,
    ...(path !== undefined ? { path } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
};

const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

/**
 * Reject submodule names that could escape the repository when joined into
 * `${gitDir}/modules/<name>`: empty, `.`/`..`, any `..` path segment,
 * backslash, absolute (POSIX-style or drive-prefixed), leading `-`. Mirrors
 * git's `submodule-config` name validation (CVE-2018-17456 lineage).
 */
export const isUnsafeSubmoduleName = (name: string): boolean => {
  if (name === '') return true;
  if (name === '.') return true;
  if (name === '..') return true;
  if (name.includes('\\')) return true;
  if (name.startsWith('-')) return true;
  if (name.startsWith('/')) return true;
  if (DRIVE_LETTER_PREFIX.test(name)) return true;
  for (const segment of name.split('/')) {
    if (segment === '..') return true;
  }
  return false;
};

const deriveChildContext = async (
  ctx: Context,
  name: string | undefined,
  treeRelPath: FilePath,
  visited: ReadonlySet<string>,
): Promise<Context | undefined> => {
  if (name === undefined) return undefined;
  if (isUnsafeSubmoduleName(name)) return undefined;
  const gitDir = `${ctx.layout.gitDir}/modules/${name}`;
  if (visited.has(gitDir)) return undefined;
  if (!(await ctx.fs.exists(`${gitDir}/HEAD`))) return undefined;
  const workDir = `${ctx.layout.workDir}/${treeRelPath}`;
  const { promisor: _drop, ...rest } = ctx;
  return Object.freeze({
    ...rest,
    layout: Object.freeze({
      workDir,
      gitDir,
      bare: false,
      ...(ctx.layout.homeDir !== undefined ? { homeDir: ctx.layout.homeDir } : {}),
    }),
    cwd: workDir,
  });
};

const tryReadTree = async (ctx: Context, commitId: ObjectId): Promise<Tree | undefined> => {
  try {
    return await readTree(ctx, commitId);
  } catch (err) {
    if (err instanceof TsgitError) {
      const code = err.data.code;
      if (code === 'OBJECT_NOT_FOUND') return undefined;
      if (code === 'FILE_NOT_FOUND') return undefined;
    }
    throw err;
  }
};

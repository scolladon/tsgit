/**
 * Submodule walk — yields gitlink entries from a tree-ish, optionally
 * recursing into each nested submodule whose absorbed gitdir is locally
 * available.
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
import { joinPathSegment } from './internal/join-path-segment.js';
import { deriveSubmoduleContext } from './internal/submodule-context.js';
import { type GitmodulesRow, parseGitmodules } from './parse-gitmodules.js';
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
const DECODER = new TextDecoder();

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
  const maxDepth = options?.maxDepth ?? MAX_SUBMODULE_DEPTH;
  const rootTree = await readTree(ctx, ref);
  // Stryker disable next-line ArrayDeclaration: equivalent — the visited-gitdir cycle guard is itself documented as defense-in-depth that cannot fire under safe names + the absorbed layout (paths only deepen), so seeding the set is observationally identical to seeding it with the empty array.
  const visited: ReadonlySet<string> = new Set<string>([ctx.layout.gitDir]);
  yield* walkInTree(ctx, rootTree, 0, undefined, '', visited, recursive, maxDepth);
}

async function* walkInTree(
  ctx: Context,
  tree: Tree,
  depth: number,
  parent: FilePath | undefined,
  pathPrefix: string,
  visited: ReadonlySet<string>,
  recursive: boolean,
  maxDepth: number,
): AsyncIterable<SubmoduleEntry> {
  const rows = await readGitmodules(ctx, tree);
  // Stryker disable next-line ObjectLiteral: equivalent — `walkTree`'s `recursive` option defaults to `true` when omitted (see `walk-tree.ts`), so `{}` and `{ recursive: true }` produce identical traversals.
  for await (const entry of walkTree(ctx, tree, { recursive: true })) {
    if (entry.mode !== FILE_MODE.GITLINK) continue;
    const fullPath = joinPathSegment(pathPrefix, entry.path) as FilePath;
    const row = rows.get(entry.path);
    yield buildEntry(row, entry.path, entry.id, fullPath, depth, parent);
    if (!recursive) continue;
    if (depth >= maxDepth) continue;
    const childCtx = await deriveSubmoduleContext(ctx, row?.name, entry.path, visited);
    if (childCtx === undefined) continue;
    const childTree = await tryReadTree(childCtx, entry.id);
    if (childTree === undefined) continue;
    const nextVisited = new Set(visited).add(childCtx.layout.gitDir);
    yield* walkInTree(
      childCtx,
      childTree,
      depth + 1,
      fullPath,
      fullPath,
      nextVisited,
      recursive,
      maxDepth,
    );
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

const readGitmodules = async (
  ctx: Context,
  tree: Tree,
): Promise<ReadonlyMap<string, GitmodulesRow>> => {
  const file = tree.entries.find((e) => e.name === '.gitmodules');
  if (file === undefined) return new Map();
  if (file.mode !== FILE_MODE.REGULAR && file.mode !== FILE_MODE.EXECUTABLE) return new Map();
  const blob = await readBlob(ctx, file.id, { maxBytes: MAX_GITMODULES_BYTES });
  const text = DECODER.decode(blob.content);
  const rows = new Map<string, GitmodulesRow>();
  for (const row of parseGitmodules(text)) {
    if (row.path === undefined) continue;
    rows.set(row.path, row);
  }
  return rows;
};

// `readTree` is invoked with an ObjectId here, so `resolveRef` is skipped and
// `FILE_NOT_FOUND` cannot surface — loose-object misses are already remapped to
// `OBJECT_NOT_FOUND` by `readObject`. Only the single not-fetched-yet code is
// caught; anything else (e.g. UNEXPECTED_OBJECT_TYPE) rethrows.
const tryReadTree = async (ctx: Context, commitId: ObjectId): Promise<Tree | undefined> => {
  try {
    return await readTree(ctx, commitId);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND') return undefined;
    throw err;
  }
};

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
    const fullPath = joinPath(pathPrefix, entry.path) as FilePath;
    const row = rows.get(entry.path);
    yield buildEntry(row, entry.path, entry.id, fullPath, depth, parent);
    if (!recursive) continue;
    if (depth >= maxDepth) continue;
    const childCtx = await deriveChildContext(ctx, row?.name, entry.path, visited);
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
  const text = DECODER.decode(blob.content);
  const rows = new Map<string, GitmodulesRow>();
  for (const row of parseGitmodules(text)) {
    if (row.path === undefined) continue;
    rows.set(row.path, row);
  }
  return rows;
};

/**
 * `name` is the `.gitmodules` subsection name as returned by `parseGitmodules`,
 * which already rejects unsafe names; no second `isUnsafeSubmoduleName` check
 * is needed here — a defensive call would be unreachable dead code.
 */
const deriveChildContext = async (
  ctx: Context,
  name: string | undefined,
  treeRelPath: FilePath,
  visited: ReadonlySet<string>,
): Promise<Context | undefined> => {
  // Stryker disable next-line ConditionalExpression: equivalent — letting an `undefined` name through builds `gitDir = '…/modules/undefined'`, which fails the next `fs.exists` probe and still returns `undefined`; identical observable behaviour.
  if (name === undefined) return undefined;
  // Stryker disable next-line StringLiteral: equivalent — emptying the path template would leave `gitDir === '/modules/'` (or similar), which fails the `${gitDir}/HEAD` existence probe just as a real-but-uninitialised path would, so recursion is skipped identically.
  const gitDir = `${ctx.layout.gitDir}/modules/${name}`;
  // Defense-in-depth: under the absorbed layout + safe-name rules, the child
  // gitDir strictly extends an ancestor (`/modules/<name>` is appended at every
  // step), so it can never equal a visited entry — the guard is intentionally
  // present to catch future contract changes (e.g. a relaxed name rule).
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — visited.has(gitDir) is always false under the current contract, so replacing it with `false` produces identical behaviour; the guard's value is defensive, not behavioral.
  if (visited.has(gitDir)) return undefined;
  // Stryker disable next-line ConditionalExpression: equivalent — when the HEAD probe is false (uninitialised), removing the early `return undefined` lets the child Context be returned; `tryReadTree` then catches the resulting `OBJECT_NOT_FOUND` and yields the same "no children" outcome.
  if (!(await ctx.fs.exists(`${gitDir}/HEAD`))) return undefined;
  // Stryker disable next-line StringLiteral: equivalent — `workDir` is informational on the child layout; no read primitive consults it (every read selects an object store by `gitDir`), so an empty `workDir` template produces no observable difference.
  const workDir = `${ctx.layout.workDir}/${treeRelPath}`;
  // Drop `promisor` AND `hooks` — both close over the parent ctx and would fire
  // against the parent's gitdir if invoked while reading the child store.
  const { promisor: _promisor, hooks: _hooks, ...rest } = ctx;
  return Object.freeze({
    ...rest,
    layout: Object.freeze({
      workDir,
      gitDir,
      // Stryker disable next-line BooleanLiteral: equivalent — no read primitive branches on `layout.bare`; the field is informational on the child Context, so flipping it has no observable effect on `walkSubmodules`.
      bare: false,
      // Stryker disable next-line ConditionalExpression,BooleanLiteral,EqualityOperator,ObjectLiteral: equivalent — `homeDir` is unused by any read primitive (it only matters when expanding `core.excludesFile = ~/...`, which `walkSubmodules` never resolves), so the spread shape has no observable effect; the conditional only exists to satisfy `exactOptionalPropertyTypes`.
      ...(ctx.layout.homeDir !== undefined ? { homeDir: ctx.layout.homeDir } : {}),
    }),
    cwd: workDir,
  });
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

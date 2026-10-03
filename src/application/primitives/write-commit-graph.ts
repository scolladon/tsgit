/**
 * Writes `objects/info/commit-graph`, byte-identical to
 * `git commit-graph write --reachable` for the same commit set. Sources
 * commits from every resolvable REF (`--reachable`'s root set, distinct
 * from `gc`'s `HEAD + index + reflogs` retention roots) via `walkCommits` — never from an existing graph, corrupt or not, which
 * would encode a stale generation set instead of a fresh one.
 *
 * @writes
 *   surface: commitGraph
 *   kind:    byte-identical
 *   format:  commit-graph-v1
 */
import {
  type CommitGraphWriterCommit,
  serializeCommitGraph,
} from '../../domain/commit/commit-graph-writer.js';
import { TsgitError } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteFile } from './atomic-write.js';
import { enumerateRefs } from './enumerate-refs.js';
import { hasGrafts } from './internal/commit-graph-compatible.js';
import { isShallowRepository } from './internal/shallow-set.js';
import {
  commitGraphChainPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
} from './path-layout.js';
import { resolveRef } from './resolve-ref.js';
import { walkCommits } from './walk-commits.js';

export interface WriteCommitGraphResult {
  readonly commitCount: number;
}

const commitGraphLocked = (lockPath: string): TsgitError =>
  new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'commit-graph', path: lockPath });

/**
 * Every ref's peeled target (annotated tags follow through to the tagged
 * object, matching `--reachable`) — refs-only, not gc's wider retention
 * roots. An unresolvable ref (unborn HEAD, a dangling symref) roots
 * nothing rather than failing the whole write, mirroring fsck's own
 * `addRefRoots` tolerance for the same conditions.
 */
async function commitGraphRoots(ctx: Context): Promise<readonly ObjectId[]> {
  const refNames = await enumerateRefs(ctx);
  const roots = new Set<ObjectId>();
  for (const name of refNames) {
    try {
      roots.add(await resolveRef(ctx, name, { peel: true }));
    } catch {
      // Unresolvable ref — tolerated, roots nothing.
    }
  }
  return [...roots];
}

async function collectCommits(
  ctx: Context,
  roots: readonly ObjectId[],
): Promise<CommitGraphWriterCommit[]> {
  const commits: CommitGraphWriterCommit[] = [];
  if (roots.length === 0) return commits;
  for await (const commit of walkCommits(ctx, { from: roots })) {
    commits.push({
      id: commit.id,
      rootTree: commit.data.tree,
      parents: commit.data.parents,
      committerDate: commit.data.committer.timestamp,
    });
  }
  return commits;
}

const GRAPH_LAYER_SUFFIX = '.graph';

const isAbsent = (error: unknown): boolean => {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
};

async function removeIfPresent(ctx: Context, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
}

async function chainLayerNames(ctx: Context, layersDir: string): Promise<readonly string[]> {
  try {
    const entries = await ctx.fs.readdir(layersDir);
    return entries.filter((entry) => entry.name.endsWith(GRAPH_LAYER_SUFFIX)).map((e) => e.name);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

/**
 * git's `expire_commit_graphs` after a non-split write: the single file now
 * answers every lookup, so the chain manifest and every layer go.
 */
async function expireCommitGraphChain(ctx: Context): Promise<void> {
  const gitDir = commonGitDir(ctx);
  await removeIfPresent(ctx, commitGraphChainPath(gitDir));
  const layersDir = commitGraphLayersDir(gitDir);
  for (const name of await chainLayerNames(ctx, layersDir)) {
    await removeIfPresent(ctx, `${layersDir}/${name}`);
  }
}

/**
 * No file is written for a repository with no commits, or a shallow one —
 * pinned against git 2.55.0 (`git commit-graph write --reachable`, both
 * exit 0 with no `objects/info/commit-graph` produced): an empty commit
 * set encodes nothing worth a file, and a shallow boundary makes the
 * generation-number invariant the graph format itself relies on unsound
 * (a shallow commit's true depth from its full history is unknown). This
 * is checked BEFORE the walk, not after, since a shallow repository never
 * needs one. A registered graft refuses the write likewise.
 */
export async function writeCommitGraph(ctx: Context): Promise<WriteCommitGraphResult> {
  if (await isShallowRepository(ctx)) return { commitCount: 0 };
  if (await hasGrafts(ctx)) return { commitCount: 0 };

  const roots = await commitGraphRoots(ctx);
  const commits = await collectCommits(ctx, roots);
  if (commits.length === 0) return { commitCount: 0 };

  const bytes = serializeCommitGraph(commits, ctx.hashConfig);
  const trailerStart = bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);

  const path = commitGraphPath(commonGitDir(ctx));
  await atomicWriteFile(ctx, path, bytes, commitGraphLocked);
  await expireCommitGraphChain(ctx);

  return { commitCount: commits.length };
}

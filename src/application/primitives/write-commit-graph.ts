/**
 * Writes `objects/info/commit-graph`, byte-identical to
 * `git commit-graph write --reachable` for the same commit set (Pin C, Pin
 * K). Sources commits from every resolvable REF (Pin O: `--reachable`'s
 * root set, distinct from `gc`'s `HEAD + index + reflogs` retention roots)
 * via `walkCommits` — never from an existing graph, corrupt or not, which
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
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteFile } from './atomic-write.js';
import { enumerateRefs } from './enumerate-refs.js';
import { commitGraphPath, commonGitDir } from './path-layout.js';
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
 * roots (Pin O). An unresolvable ref (unborn HEAD, a dangling symref) roots
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

export async function writeCommitGraph(ctx: Context): Promise<WriteCommitGraphResult> {
  const roots = await commitGraphRoots(ctx);
  const commits = await collectCommits(ctx, roots);

  const bytes = serializeCommitGraph(commits, ctx.hashConfig);
  const trailerStart = bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);

  const path = commitGraphPath(commonGitDir(ctx));
  await atomicWriteFile(ctx, path, bytes, commitGraphLocked);

  return { commitCount: commits.length };
}

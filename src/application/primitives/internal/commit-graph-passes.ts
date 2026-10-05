/**
 * The passes git's commit-graph writer makes over the commits it parses —
 * typing the roots, `close_reachable`, `copy_oids_to_commits`, then the
 * generation walks and `write_graph_chunk_data`. git never remembers a failed
 * parse, so every pass that reaches a commit that does not parse logs it
 * again; a commit that parses is read once and served from then on.
 */
import { commitParseFailed } from '../../../domain/commands/error.js';
import type { BloomFilterSettings } from '../../../domain/commit/bloom-filter.js';
import type {
  CommitGraphWriterCommit,
  GenerationWalkView,
} from '../../../domain/commit/commit-graph-writer.js';
import type { TsgitError } from '../../../domain/error.js';
import { isObjectNotFound, treeUnreadable } from '../../../domain/objects/error.js';
import type { GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

export interface CommitGraphParser extends GenerationWalkView {
  /** git's `add_ref_to_set` type probe: the commit `id` names, silently `undefined` for anything else. */
  readonly probe: (id: ObjectId) => Promise<CommitGraphWriterCommit | undefined>;
  /** git's `repo_parse_commit`: the commit, or `undefined` once the failure is logged. */
  readonly read: (id: ObjectId) => Promise<CommitGraphWriterCommit | undefined>;
}

/** Whether a layer of the existing chain already holds `id`. */
export type InGraph = (id: ObjectId) => boolean;

const writerCommit = (object: GitObject): CommitGraphWriterCommit | undefined =>
  object.type === 'commit'
    ? {
        id: object.id,
        rootTree: object.data.tree,
        parents: object.data.parents,
        committerDate: object.data.committer.timestamp,
      }
    : undefined;

async function readOrAbsent(ctx: Context, id: ObjectId): Promise<GitObject | undefined> {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    if (isObjectNotFound(error)) return undefined;
    throw error;
  }
}

/** A read's outcome: the commit, or the line git logs for an object that does not parse as one. */
async function outcomeOf(ctx: Context, id: ObjectId): Promise<CommitGraphWriterCommit | string> {
  const object = await readOrAbsent(ctx, id);
  if (object === undefined) return `Could not read ${id}`;
  return writerCommit(object) ?? `Object ${id} not a commit`;
}

/** One write's parser: successes kept, failures kept only as the line each later parse logs again. */
export function createCommitGraphParser(ctx: Context): CommitGraphParser {
  const parsed = new Map<ObjectId, CommitGraphWriterCommit>();
  const failures = new Map<ObjectId, string>();
  const parse = (id: ObjectId): void => {
    const line = failures.get(id);
    if (line !== undefined) ctx.logger?.error?.(line, { id });
  };
  const settle = async (id: ObjectId): Promise<CommitGraphWriterCommit | string> => {
    const outcome = parsed.get(id) ?? failures.get(id) ?? (await outcomeOf(ctx, id));
    if (typeof outcome !== 'string') parsed.set(id, outcome);
    return outcome;
  };
  const probe = async (id: ObjectId): Promise<CommitGraphWriterCommit | undefined> => {
    const outcome = await settle(id);
    return typeof outcome === 'string' ? undefined : outcome;
  };
  const read = async (id: ObjectId): Promise<CommitGraphWriterCommit | undefined> => {
    const outcome = await settle(id);
    if (typeof outcome !== 'string') return outcome;
    failures.set(id, outcome);
    parse(id);
    return undefined;
  };
  return { parse, parsed: (id) => parsed.get(id), probe, read };
}

/** The roots that name commits, in ref order — git's `--reachable` set. */
export async function rootCommits(
  parser: CommitGraphParser,
  roots: readonly ObjectId[],
): Promise<readonly ObjectId[]> {
  const commits: ObjectId[] = [];
  for (const root of roots) {
    if ((await parser.probe(root)) !== undefined) commits.push(root);
  }
  return commits;
}

/** git's `close_reachable`: each oid parsed in turn, its parents appended once; the graph's own are not followed. */
export async function closeReachable(
  parser: CommitGraphParser,
  roots: readonly ObjectId[],
  inGraph: InGraph,
): Promise<readonly ObjectId[]> {
  const oids = [...roots];
  const reachable = new Set(roots);
  // The array iterator re-reads the length, so the parents appended below are visited too.
  for (const id of oids) {
    if (inGraph(id)) continue;
    const commit = await parser.read(id);
    for (const parent of commit?.parents ?? []) {
      if (reachable.has(parent)) continue;
      reachable.add(parent);
      oids.push(parent);
    }
  }
  return oids;
}

/** git's `copy_oids_to_commits`: every oid once in byte order, the graph's own skipped, each parsed. */
export async function copyOidsToCommits(
  parser: CommitGraphParser,
  oids: readonly ObjectId[],
  inGraph: InGraph,
): Promise<readonly ObjectId[]> {
  const commits = [...new Set(oids)].sort().filter((id) => !inGraph(id));
  for (const id of commits) await parser.read(id);
  return commits;
}

/**
 * How the first commit that does not parse refuses the write: git's
 * `write_graph_chunk_data` cannot parse it, or — with changed paths on —
 * `compute_bloom_filters` reaches it first, every such commit sorting lowest,
 * and cannot read its tree.
 */
export type UnparsedRefusal = (id: ObjectId) => TsgitError;

export const refusalFor = (changedPaths: BloomFilterSettings | undefined): UnparsedRefusal =>
  changedPaths === undefined ? commitParseFailed : treeUnreadable;

/** The commits in `order`, the first that does not parse refusing after its line is logged once more. */
export function parsedForWrite(
  parser: CommitGraphParser,
  order: readonly ObjectId[],
  refuse: UnparsedRefusal,
): readonly CommitGraphWriterCommit[] {
  return order.map((id) => {
    const commit = parser.parsed(id);
    if (commit !== undefined) return commit;
    parser.parse(id);
    throw refuse(id);
  });
}

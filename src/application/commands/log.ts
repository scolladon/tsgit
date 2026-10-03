import { sortInTopologicalOrder } from '../../domain/commit/topological-sort.js';
import type { AuthorIdentity, Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

/**
 * Walk order. `'date'` (default) yields every reachable commit across all
 * parents, newest committer-date first (git's default `git log` order);
 * `'first-parent'` follows only the first parent (`git log --first-parent`).
 */
export type LogOrder = 'date' | 'first-parent';

/**
 * Topological order over the walked commits — no commit before all its
 * children. `'graph'` keeps each line of history together (`--topo-order`),
 * `'commit-date'` (`--date-order`) and `'author-date'`
 * (`--author-date-order`) show the newest ready commit first.
 */
export type LogTopoOrder = 'graph' | 'commit-date' | 'author-date';

export interface LogOptions {
  readonly rev?: string;
  readonly order?: LogOrder;
  readonly limit?: number;
  readonly excluding?: ReadonlyArray<string>;
  readonly before?: Date;
  readonly minParents?: number;
  readonly maxParents?: number;
  readonly topoOrder?: LogTopoOrder;
  /** Output newest-last (`--reverse`), applied after `limit` as git does. */
  readonly reverse?: boolean;
}

export interface LogEntry {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
}

const withinParentBand = (parentCount: number, opts: LogOptions): boolean => {
  if (opts.minParents !== undefined && parentCount < opts.minParents) return false;
  if (opts.maxParents !== undefined && parentCount > opts.maxParents) return false;
  return true;
};

/**
 * Walk commits starting from `rev` (default: HEAD), yielding ordered `LogEntry`
 * records. By default walks every reachable commit across all parents in
 * committer-date order; `order: 'first-parent'` follows only the first parent;
 * `topoOrder` re-sorts the walked commits topologically.
 * Honors `limit`, `excluding` (commit-ish stops), `before` (only commits with
 * `committer.timestamp < before`), `minParents`/`maxParents` (parent-count
 * band) and `reverse` (applied last, after `limit`).
 */
export const log = async (
  ctx: Context,
  opts: LogOptions = {},
): Promise<ReadonlyArray<LogEntry>> => {
  await assertOperationalRepository(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const walk =
    opts.order === 'first-parent'
      ? walkCommits(ctx, { from: [startId], until: exclude, order: 'first-parent' })
      : walkCommitsByDate(ctx, { from: [startId], until: exclude });
  const ordered = opts.topoOrder === undefined ? walk : await topologically(walk, opts.topoOrder);
  const shown = await collectShown(ordered, opts);
  return opts.reverse === true ? shown.reverse() : shown;
};

/** git's limited walk: read every commit first, then sort them all. */
const topologically = async (
  walk: AsyncIterable<Commit>,
  order: LogTopoOrder,
): Promise<ReadonlyArray<Commit>> => {
  const commits: Commit[] = [];
  for await (const commit of walk) commits.push(commit);
  return sortInTopologicalOrder(commits, order);
};

const collectShown = async (
  commits: AsyncIterable<Commit> | Iterable<Commit>,
  opts: LogOptions,
): Promise<LogEntry[]> => {
  const before = opts.before;
  const out: LogEntry[] = [];
  for await (const value of commits) {
    if (before !== undefined && value.data.committer.timestamp >= before.getTime() / 1000) {
      continue;
    }
    if (!withinParentBand(value.data.parents.length, opts)) {
      continue;
    }
    out.push(entryOf(value));
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
};

const entryOf = (commit: Commit): LogEntry => ({
  id: commit.id,
  tree: commit.data.tree,
  parents: commit.data.parents,
  author: commit.data.author,
  committer: commit.data.committer,
  message: commit.data.message,
});

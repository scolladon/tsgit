import type { AuthorIdentity, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

/**
 * Walk order. `'date'` (default) yields every reachable commit across all
 * parents, newest committer-date first (git's default `git log` order);
 * `'first-parent'` follows only the first parent (`git log --first-parent`).
 */
export type LogOrder = 'date' | 'first-parent';

export interface LogOptions {
  readonly rev?: string;
  readonly order?: LogOrder;
  readonly limit?: number;
  readonly excluding?: ReadonlyArray<string>;
  readonly before?: Date;
}

export interface LogEntry {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
}

/**
 * Walk commits starting from `rev` (default: HEAD), yielding ordered `LogEntry`
 * records. By default walks every reachable commit across all parents in
 * committer-date order; `order: 'first-parent'` follows only the first parent.
 * Honors `limit`, `excluding` (commit-ish stops), and `before` (only commits with
 * `committer.timestamp < before`).
 */
export const log = async (
  ctx: Context,
  opts: LogOptions = {},
): Promise<ReadonlyArray<LogEntry>> => {
  await assertRepository(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const before = opts.before;
  const walk =
    opts.order === 'first-parent'
      ? walkCommits(ctx, { from: [startId], until: exclude, order: 'first-parent' })
      : walkCommitsByDate(ctx, { from: [startId], until: exclude });
  const out: LogEntry[] = [];
  let yielded = 0;
  for await (const value of walk) {
    if (before !== undefined && value.data.committer.timestamp >= before.getTime() / 1000) {
      continue;
    }
    out.push({
      id: value.id,
      tree: value.data.tree,
      parents: value.data.parents,
      author: value.data.author,
      committer: value.data.committer,
      message: value.data.message,
    });
    yielded += 1;
    if (opts.limit !== undefined && yielded >= opts.limit) break;
  }
  return out;
};

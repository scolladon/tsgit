/**
 * Tier-1 `whatchanged` command — git's `git whatchanged` (modern alias for
 * `git log --raw --no-merges`): walk the commits reachable from a revision and
 * pair each non-merge commit with the raw structured changes it introduced
 * against its first parent (root: against the empty tree). Merge commits are
 * excluded from the output but still traversed for reachability.
 *
 * Returns structured data only (ADR-249): each entry reuses `log`'s commit
 * projection (`WhatchangedEntry extends LogEntry`) plus a `TreeDiff`. The `--raw`
 * line rendering, oid abbreviation, and date formatting are caller concerns.
 */
import type { TreeDiff } from '../../domain/diff/index.js';
import type { Context } from '../../ports/context.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { diffCommitAgainstParent } from './internal/commit-diff.js';
import { assertRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';
import type { LogEntry, LogOrder } from './log.js';

export interface WhatchangedOptions {
  readonly rev?: string;
  readonly order?: LogOrder;
  readonly limit?: number;
  readonly excluding?: ReadonlyArray<string>;
  readonly before?: Date;
}

export interface WhatchangedEntry extends LogEntry {
  /** Raw changes against the first parent (root: against the empty tree). */
  readonly changes: TreeDiff;
}

/**
 * Walk commits from `rev` (default HEAD), excluding merges (≥2 parents), and pair
 * each with its first-parent `TreeDiff` (recursive, rename-detecting like
 * `git show`). Honors `order`, `limit` (counts emitted entries), `excluding`
 * (commit-ish stops), and `before` (only `committer.timestamp < before`).
 */
export const whatchanged = async (
  ctx: Context,
  opts: WhatchangedOptions = {},
): Promise<ReadonlyArray<WhatchangedEntry>> => {
  await assertRepository(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const before = opts.before;
  const walk =
    opts.order === 'first-parent'
      ? walkCommits(ctx, { from: [startId], until: exclude, order: 'first-parent' })
      : walkCommitsByDate(ctx, { from: [startId], until: exclude });
  const out: WhatchangedEntry[] = [];
  let yielded = 0;
  for await (const value of walk) {
    if (value.data.parents.length >= 2) continue;
    if (before !== undefined && value.data.committer.timestamp >= before.getTime() / 1000) {
      continue;
    }
    const changes = await diffCommitAgainstParent(ctx, value.data.parents[0], value.data.tree);
    out.push({
      id: value.id,
      tree: value.data.tree,
      parents: value.data.parents,
      author: value.data.author,
      committer: value.data.committer,
      message: value.data.message,
      changes,
    });
    yielded += 1;
    if (opts.limit !== undefined && yielded >= opts.limit) break;
  }
  return out;
};

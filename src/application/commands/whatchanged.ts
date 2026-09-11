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
import type { Commit } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { diffCommitAgainstParent } from './internal/commit-diff.js';
import { assertOperationalRepository } from './internal/repo-state.js';
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

/** git's non-merge + `before` filter, in seconds (git's on-disk resolution). */
const isSelected = (commit: Commit, beforeSeconds: number | undefined): boolean => {
  if (commit.data.parents.length >= 2) return false;
  if (beforeSeconds !== undefined && commit.data.committer.timestamp >= beforeSeconds) {
    return false;
  }
  return true;
};

/** Drain the walk into the selected commits, honoring `limit` on selection, not diffing. */
const selectCommits = async (
  walk: AsyncIterable<Commit>,
  beforeSeconds: number | undefined,
  limit: number | undefined,
): Promise<Commit[]> => {
  const selected: Commit[] = [];
  for await (const commit of walk) {
    if (!isSelected(commit, beforeSeconds)) continue;
    selected.push(commit);
    if (limit !== undefined && selected.length >= limit) break;
  }
  return selected;
};

const toEntry = (commit: Commit, changes: TreeDiff): WhatchangedEntry => ({
  id: commit.id,
  tree: commit.data.tree,
  parents: commit.data.parents,
  author: commit.data.author,
  committer: commit.data.committer,
  message: commit.data.message,
  changes,
});

/**
 * Walk commits from `rev` (default HEAD), excluding merges (≥2 parents), and pair
 * each with its first-parent `TreeDiff` (recursive, rename-detecting like
 * `git show`). Honors `order`, `limit` (counts emitted entries), `excluding`
 * (commit-ish stops), and `before` (only `committer.timestamp < before`).
 *
 * Selection (walking, filtering, `limit`) and diffing are two stages: the walk
 * drains into `selected` first, then the diffs run through `boundedMapFor`
 * under the CPU bucket — a recursive, rename-detecting tree diff is
 * CPU-dominant and hydrates blob contents for similarity, so the bound follows
 * the cores rather than the I/O pool and keeps the in-flight blob footprint to
 * a handful of commits while their reads still overlap.
 */
export const whatchanged = async (
  ctx: Context,
  opts: WhatchangedOptions = {},
): Promise<ReadonlyArray<WhatchangedEntry>> => {
  await assertOperationalRepository(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const beforeSeconds = opts.before !== undefined ? opts.before.getTime() / 1000 : undefined;
  const walk =
    opts.order === 'first-parent'
      ? walkCommits(ctx, { from: [startId], until: exclude, order: 'first-parent' })
      : walkCommitsByDate(ctx, { from: [startId], until: exclude });
  const selected = await selectCommits(walk, beforeSeconds, opts.limit);
  const changes = await boundedMapFor(ctx, 'cpuBound', selected, (commit) =>
    diffCommitAgainstParent(ctx, commit.data.parents[0], commit.data.tree),
  );
  return selected.map((commit, index) => toEntry(commit, changes[index]!));
};

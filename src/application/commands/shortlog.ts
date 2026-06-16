/**
 * Tier-1 `shortlog` command — git's `git shortlog`: walk the commits reachable
 * from a revision and group them by author (or committer) identity. Returns
 * structured data only (ADR-249): per-author groups keyed by the identity name,
 * each commit carrying `{ id, email, subject }` (git's cleaned shortlog oneline),
 * oldest first; groups byte-sorted by name. The `-e` / `-n` / `-s` renderings are
 * caller projections.
 */

import {
  cleanShortlogSubject,
  groupShortlog,
  type ShortlogCommit,
  type ShortlogEntry,
  type ShortlogGroup,
} from '../../domain/shortlog/index.js';
import type { Context } from '../../ports/context.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertCommandPreamble } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

export type { ShortlogCommit, ShortlogGroup };

/** Which identity keys the grouping. */
export type ShortlogBy = 'author' | 'committer';

export interface ShortlogOptions {
  /** Commit-ish to start the walk from (full rev grammar); default `'HEAD'`. */
  readonly rev?: string;
  /** Commit-ish stops excluded from the walk (git's `A..B` / `^X` ranges). */
  readonly excluding?: ReadonlyArray<string>;
  /** Group by author (default) or committer identity. */
  readonly by?: ShortlogBy;
}

export const shortlog = async (
  ctx: Context,
  opts: ShortlogOptions = {},
): Promise<ReadonlyArray<ShortlogGroup>> => {
  await assertCommandPreamble(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const byCommitter = opts.by === 'committer';
  const entries: ShortlogEntry[] = [];
  for await (const commit of walkCommitsByDate(ctx, { from: [startId], until: exclude })) {
    const who = byCommitter ? commit.data.committer : commit.data.author;
    entries.push({
      name: who.name,
      email: who.email,
      id: commit.id,
      subject: cleanShortlogSubject(commit.data.message),
    });
  }
  return groupShortlog(entries);
};

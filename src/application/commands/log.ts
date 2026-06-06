import type { AuthorIdentity, ObjectId } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertRepository } from './internal/repo-state.js';

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
 * Honors `limit`, `excluding` (oid stops), and `before` (only commits with
 * `committer.timestamp < before`).
 */
export const log = async (
  ctx: Context,
  opts: LogOptions = {},
): Promise<ReadonlyArray<LogEntry>> => {
  await assertRepository(ctx);
  const startId = await resolveStart(ctx, opts.rev ?? 'HEAD');
  // Stryker disable next-line ArrayDeclaration: equivalent — any unresolvable seed (e.g. "Stryker was here") is caught and skipped by resolveExcluding, yielding the same empty exclusion list as [].
  const exclude = await resolveExcluding(ctx, opts.excluding ?? []);
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

const resolveStart = async (ctx: Context, rev: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(rev)) return rev as ObjectId;
  // Try the literal name first (already-prefixed full ref or `HEAD`), then
  // refs/heads/<name>, then refs/tags/<name>.
  const candidates = [rev, `refs/heads/${rev}`, `refs/tags/${rev}`];
  for (const candidate of candidates) {
    try {
      return await resolveRef(ctx, validateRefName(candidate));
    } catch {
      // continue
    }
  }
  return resolveRef(ctx, validateRefName(rev));
};

const resolveExcluding = async (
  ctx: Context,
  refs: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> => {
  const out: ObjectId[] = [];
  for (const r of refs) {
    // Stryker disable next-line Regex: equivalent — dropping either anchor only lets a non-40-char string match, but the whole string `r` is then pushed verbatim into the `until` set; `walkCommits` only does `until.has(id)` against real 40-char oids, so a malformed-length entry can never collide. The `resolveRef` fallback merely throws-and-skips the same string, leaving `out` identical either way.
    if (/^[0-9a-f]{40}$/.test(r)) {
      out.push(r as ObjectId);
      continue;
    }
    try {
      out.push(await resolveRef(ctx, validateRefName(r)));
    } catch {
      // skip unresolved exclusions
    }
  }
  return out;
};

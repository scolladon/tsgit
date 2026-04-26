import type { AuthorIdentity, ObjectId } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { assertRepository } from './internal/repo-state.js';

export interface LogOptions {
  readonly from?: string;
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
 * Walk first-parent commits starting from `from` (default: HEAD), yielding
 * ordered `LogEntry` records. Honors `limit`, `excluding` (oid stops), and
 * `before` (only commits with `committer.timestamp < before`).
 */
export const log = async (
  ctx: Context,
  opts: LogOptions = {},
): Promise<ReadonlyArray<LogEntry>> => {
  await assertRepository(ctx);
  const startId = await resolveStart(ctx, opts.from ?? 'HEAD');
  const exclude = await resolveExcluding(ctx, opts.excluding ?? []);
  const before = opts.before;
  const out: LogEntry[] = [];
  let yielded = 0;
  for await (const value of walkCommits(ctx, {
    from: [startId],
    until: exclude,
    order: 'first-parent',
  })) {
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

const resolveStart = async (ctx: Context, from: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(from)) return from as ObjectId;
  if (from === 'HEAD') return resolveRef(ctx, 'HEAD');
  // Try the literal name first (already-prefixed full ref), then refs/heads/<name>.
  const candidates = [from, `refs/heads/${from}`, `refs/tags/${from}`];
  for (const candidate of candidates) {
    try {
      return await resolveRef(ctx, validateRefName(candidate));
    } catch {
      // continue
    }
  }
  return resolveRef(ctx, validateRefName(from));
};

const resolveExcluding = async (
  ctx: Context,
  refs: ReadonlyArray<string>,
): Promise<ReadonlyArray<ObjectId>> => {
  const out: ObjectId[] = [];
  for (const r of refs) {
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

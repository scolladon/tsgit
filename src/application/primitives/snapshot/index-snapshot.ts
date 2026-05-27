import type {
  IndexEntry as DomainIndexEntry,
  GitIndex,
} from '../../../domain/git-index/index-entry.js';
import { matchesPathspec } from '../../../domain/pathspec/index.js';
import type { Context } from '../../../ports/context.js';
import type { IndexResolver } from '../../../ports/snapshot-resolvers.js';
import { createIndexEntry, type IndexEntry } from './index-entry.js';
import type { Snapshot, SnapshotOptions } from './snapshot.js';

export interface IndexSnapshotDeps {
  readonly ctx: Context;
  readonly indexResolver: IndexResolver;
}

const toEntry = (ctx: Context, row: DomainIndexEntry): IndexEntry =>
  createIndexEntry(ctx, {
    source: 'index',
    path: row.path,
    oid: row.id,
    mode: row.mode,
    stage: row.flags.stage,
    flags: {
      assumeUnchanged: row.flags.assumeValid,
      skipWorktree: row.flags.skipWorktree,
      intentToAdd: row.flags.intentToAdd,
    },
    cachedStat: {
      size: row.fileSize,
      mtimeMs: row.mtimeSeconds * 1000 + Math.floor(row.mtimeNanoseconds / 1_000_000),
      ino: BigInt(row.ino),
    },
  });

/**
 * Lazily evaluates `.git/index` via `IndexResolver`. The parsed `GitIndex`
 * is captured on the first iteration and reused across subsequent
 * iterations of the same handle (design §8.0 iteration stability):
 *
 *   - First `entries()` call → resolver.resolve(ctx) → captured reference
 *   - All subsequent `entries()` calls → stream from captured reference,
 *     bypassing the resolver entirely; `emit('index')` events on the bus
 *     never disturb an in-flight iteration.
 *   - A fresh `repo.snapshot.index()` returns a new handle whose own first
 *     iteration sees the resolver's post-invalidation state.
 *
 * `bypassCache` forwards to the resolver only for the *first* resolve on
 * this handle; once captured, subsequent calls use the captured reference.
 */
export const createIndexSnapshot = (deps: IndexSnapshotDeps): Snapshot<IndexEntry> => {
  let captured: GitIndex | null = null;

  const resolveOnce = async (bypassCache: boolean): Promise<GitIndex> => {
    if (captured !== null) return captured;
    const fresh = await deps.indexResolver.resolve(deps.ctx, { bypassCache });
    captured = fresh;
    return fresh;
  };

  async function* entries(opts?: SnapshotOptions): AsyncIterable<IndexEntry> {
    const gitIndex = await resolveOnce(opts?.bypassCache === true);
    let yielded = 0;
    const cap = opts?.maxEntries ?? Number.POSITIVE_INFINITY;
    for (const row of gitIndex.entries) {
      if (yielded >= cap) return;
      if (opts?.paths !== undefined && !matchesPathspec(opts.paths, row.path)) continue;
      yield toEntry(deps.ctx, row);
      yielded += 1;
    }
  }

  return { kind: 'index', entries };
};

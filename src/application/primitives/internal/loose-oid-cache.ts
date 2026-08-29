/**
 * Per-fanout-dir loose-object membership cache (git's own `odb_loose_cache`
 * mechanism). Amortises the per-object loose-existence probe on packed
 * walks: instead of an `exists`/`realpath` round trip per object, the
 * fanout dir (`objects/xx`, ≤256 of them) is `readdir`'d lazily at most
 * once per session, then membership is a `Set` lookup. A miss short-
 * circuits the caller with NO filesystem call — loose-first precedence is
 * unaffected because a membership HIT still routes through `ctx.fs.read`
 * (the containment gate and corrupt-loose inflate-error surfacing are
 * unchanged).
 *
 * Keyed on `ctx.session`, not `ctx` itself — the fanout dir lives under
 * `commonGitDir(ctx)`, identical across every Context derived from the same
 * repository-open, so this cache is shared across worktree/submodule/audit
 * derivations that keep the session rather than missing on every spread.
 *
 * Invalidation is local, not the (currently unwired) generation counter:
 * `writeObject` records the written oid into a present cached set — a write
 * only ever ADDS a member, so no re-readdir is forced on read/write-
 * interleaved flows; an unprobed prefix stays lazy. Pruning is the opposite
 * shape: `maintenance`'s `gc` task is tsgit's own pruner now, and it drops
 * the whole prefix's cached set via `forgetLooseOidPrefix` for every prefix
 * it unlinks from — the same escape hatch that already tolerated an
 * EXTERNAL pruner (a concurrent `git gc`) removing a loose file out from
 * under a cached HIT.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir, objectsDir } from '../path-layout.js';
import { errorDataCode } from './error-data-code.js';

const fanoutCache = new WeakMap<Context['session'], Map<string, Set<string>>>();

const prefixOf = (id: ObjectId): string => id.slice(0, 2);
const suffixOf = (id: ObjectId): string => id.slice(2);

function isMissingFanoutDir(error: unknown): boolean {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
}

async function loadFanoutSet(ctx: Context, prefix: string): Promise<Set<string>> {
  let byPrefix = fanoutCache.get(ctx.session);
  if (byPrefix === undefined) {
    byPrefix = new Map();
    fanoutCache.set(ctx.session, byPrefix);
  }
  const cached = byPrefix.get(prefix);
  if (cached !== undefined) return cached;

  let suffixes: Set<string>;
  try {
    const entries = await ctx.fs.readdir(objectsDir(commonGitDir(ctx), prefix));
    suffixes = new Set(entries.map((entry) => entry.name));
  } catch (error) {
    if (!isMissingFanoutDir(error)) throw error;
    suffixes = new Set();
  }
  byPrefix.set(prefix, suffixes);
  return suffixes;
}

/** Membership test for a loose object, backed by the lazy per-prefix cache. */
export async function probeLooseOid(ctx: Context, id: ObjectId): Promise<boolean> {
  const suffixes = await loadFanoutSet(ctx, prefixOf(id));
  return suffixes.has(suffixOf(id));
}

/**
 * Record a just-written loose object into its prefix's cached set. A write
 * only ever adds a member, so inserting beats dropping the whole set —
 * dropping would force an O(dir) re-readdir on the next same-prefix probe
 * in read/write-interleaved flows. An unprobed prefix has no set yet and
 * stays lazy. Call after a loose object is written under this Context.
 * `forgetLooseOidPrefix` (below) is the removal counterpart a pruner calls.
 */
export function invalidateLooseOid(ctx: Context, id: ObjectId): void {
  fanoutCache.get(ctx.session)?.get(prefixOf(id))?.add(suffixOf(id));
}

/**
 * Drop the cached set for `id`'s prefix entirely. Called by `maintenance`'s
 * `gc` task for every prefix it unlinks a loose object from, and also when
 * a cached HIT turns out stale (the file vanished under us — an external
 * pruner such as a concurrent `git gc` removed it), so the next probe
 * re-reads the directory.
 */
export function forgetLooseOidPrefix(ctx: Context, id: ObjectId): void {
  fanoutCache.get(ctx.session)?.delete(prefixOf(id));
}

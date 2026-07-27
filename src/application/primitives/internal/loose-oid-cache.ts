/**
 * Per-fanout-dir loose-object membership cache (git's own `odb_loose_cache`
 * mechanism). Amortises the per-object loose-existence probe on packed
 * walks: instead of an `exists`/`realpath` round trip per object, the
 * fanout dir (`objects/xx`, ≤256 of them) is `readdir`'d lazily at most
 * once per `Context`, then membership is a `Set` lookup. A miss short-
 * circuits the caller with NO filesystem call — loose-first precedence is
 * unaffected because a membership HIT still routes through `ctx.fs.read`
 * (the containment gate and corrupt-loose inflate-error surfacing are
 * unchanged).
 *
 * Invalidation is local, not the (currently unwired) generation counter:
 * `writeObject` records the written oid into a present cached set (writes
 * only ever ADD a loose object — tsgit never prunes them), so no re-readdir
 * is forced on read/write-interleaved flows; an unprobed prefix stays lazy.
 */
import { TsgitError } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir, objectsDir } from '../path-layout.js';

const fanoutCache = new WeakMap<Context, Map<string, Set<string>>>();

const prefixOf = (id: ObjectId): string => id.slice(0, 2);
const suffixOf = (id: ObjectId): string => id.slice(2);

function isMissingFanoutDir(error: unknown): boolean {
  return (
    error instanceof TsgitError &&
    (error.data.code === 'FILE_NOT_FOUND' || error.data.code === 'NOT_A_DIRECTORY')
  );
}

async function loadFanoutSet(ctx: Context, prefix: string): Promise<Set<string>> {
  let byPrefix = fanoutCache.get(ctx);
  if (byPrefix === undefined) {
    byPrefix = new Map();
    fanoutCache.set(ctx, byPrefix);
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
 * only ever adds a member (tsgit never prunes loose objects), so inserting
 * beats dropping the whole set — dropping would force an O(dir) re-readdir
 * on the next same-prefix probe in read/write-interleaved flows. An
 * unprobed prefix has no set yet and stays lazy. Call after a loose object
 * is written under this Context.
 */
export function invalidateLooseOid(ctx: Context, id: ObjectId): void {
  fanoutCache.get(ctx)?.get(prefixOf(id))?.add(suffixOf(id));
}

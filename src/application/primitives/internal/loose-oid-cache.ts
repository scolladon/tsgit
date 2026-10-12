/**
 * Per-fanout-dir loose-object membership cache (git's own `odb_loose_cache`
 * mechanism). Amortises the per-object loose-existence probe on packed
 * walks: instead of an `exists`/`realpath` round trip per object, the
 * fanout dir (`objects/xx`, ≤256 of them) is `readdir`'d lazily at most
 * once per session, then membership is a `Set` lookup. A miss short-
 * circuits the caller with NO filesystem call. The store split this cache
 * now serves: buffered reads (`resolveObjectContentWithDepth`) consult packs
 * FIRST and fall to this cache only on a pack miss; `openBlobSource`'s
 * streamed blob reads and `hasObject`'s fallback still consult it as their
 * loose-first arm. Either way, a membership HIT routes through `ctx.fs.read`
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

import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { ObjectSourceReader } from '../../../ports/object-source-access.js';
import { fanoutDirIn } from '../path-layout.js';
import { looseLocationOf, type SourceLocation } from './source-location.js';

const fanoutCache = new WeakMap<Context['session'], Map<string, Set<string>>>();

const prefixOf = (id: ObjectId): string => id.slice(0, 2);
const suffixOf = (id: ObjectId): string => id.slice(2);

/** `readdir` on a missing fanout dir reports `FILE_NOT_FOUND` on every adapter;
 *  `NOT_A_DIRECTORY` covers the other tolerated shape, a regular file occupying the fanout
 *  path instead of a directory. Both mean "nothing loose here yet". Exported for
 *  `resolve-oid-prefix.ts`'s `scanLoose`, which folds the identical two shapes. */
export function isMissingFanoutDir(error: unknown): boolean {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
}

const locationCache = new WeakMap<SourceLocation, Map<string, Set<string>>>();

const primaryPrefixMap = (ctx: Context): Map<string, Set<string>> => {
  let byPrefix = fanoutCache.get(ctx.session);
  if (byPrefix === undefined) {
    byPrefix = new Map();
    fanoutCache.set(ctx.session, byPrefix);
  }
  return byPrefix;
};

const locationPrefixMap = (location: SourceLocation): Map<string, Set<string>> => {
  let byPrefix = locationCache.get(location);
  if (byPrefix === undefined) {
    byPrefix = new Map();
    locationCache.set(location, byPrefix);
  }
  return byPrefix;
};

async function listSuffixes(fs: ObjectSourceReader, dir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries.map((entry) => entry.name));
  } catch (error) {
    if (!isMissingFanoutDir(error)) throw error;
    return new Set();
  }
}

async function loadFanoutSet(
  ctx: Context,
  prefix: string,
  location?: SourceLocation,
): Promise<Set<string>> {
  const byPrefix = location === undefined ? primaryPrefixMap(ctx) : locationPrefixMap(location);
  const cached = byPrefix.get(prefix);
  if (cached !== undefined) return cached;

  const loose = looseLocationOf(ctx, location);
  const suffixes = await listSuffixes(loose.fs, fanoutDirIn(loose.objectsDir, prefix));
  byPrefix.set(prefix, suffixes);
  return suffixes;
}

/** Membership test for a loose object, backed by the lazy per-prefix cache. With a `location`
 *  the listing is read through that location's fs and cached by the location's identity. */
export async function probeLooseOid(
  ctx: Context,
  id: ObjectId,
  location?: SourceLocation,
): Promise<boolean> {
  const suffixes = await loadFanoutSet(ctx, prefixOf(id), location);
  return suffixes.has(suffixOf(id));
}

const cachedPrefixes = (
  ctx: Context,
  location: SourceLocation | undefined,
): Map<string, Set<string>> | undefined =>
  location === undefined ? fanoutCache.get(ctx.session) : locationCache.get(location);

/**
 * Record a just-written loose object into its prefix's cached set. A write
 * only ever adds a member, so inserting beats dropping the whole set —
 * dropping would force an O(dir) re-readdir on the next same-prefix probe
 * in read/write-interleaved flows. An unprobed prefix has no set yet and
 * stays lazy. Call after a loose object is written under this Context.
 * `forgetLooseOidPrefix` (below) is the removal counterpart a pruner calls.
 */
export function invalidateLooseOid(ctx: Context, id: ObjectId, location?: SourceLocation): void {
  cachedPrefixes(ctx, location)?.get(prefixOf(id))?.add(suffixOf(id));
}

/**
 * Drop the cached set for `id`'s prefix entirely. Called by `maintenance`'s
 * `gc` task for every prefix it unlinks a loose object from, when a cached
 * HIT turns out stale (the file vanished under us — an external pruner such
 * as a concurrent `git gc` removed it), and by `pack-miss-rescan.ts`'s
 * full-object-miss retry for every id that missed during the current wave —
 * the loose half of git's `reprepare_packed_git` retry, scoped to exactly
 * the prefixes a miss actually consulted rather than the whole session
 * cache. Either caller's goal is the same: the next probe re-reads the
 * directory instead of trusting a listing that may now be stale.
 */
export function forgetLooseOidPrefix(ctx: Context, id: ObjectId, location?: SourceLocation): void {
  cachedPrefixes(ctx, location)?.delete(prefixOf(id));
}

import type { CacheTreeEntry } from '../../../../domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../domain/git-index/index-parser.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { ZERO_OID } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { probeLooseOid } from '../../../primitives/internal/loose-oid-cache.js';
import { readIndex } from '../../../primitives/read-index.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { listReflogs, readReflog } from '../../../primitives/reflog-store.js';
import { resolveRef } from '../../../primitives/resolve-ref.js';
import type { FsckOptions } from './types.js';

const CACHE_TREE_SIGNATURE = 'TREE';

/**
 * Whether `id` genuinely exists and is accessible — a loose-then-pack
 * existence probe, deliberately INDEPENDENT of `universe` membership:
 * `universe` is narrowed for reasons that have nothing to do with object
 * health (`full: false` excludes packs outright as a scan-depth choice;
 * `connectivityOnly` widens it to admit an oid whose housing pack later
 * fails its own header gate). Measured against git 2.55.0: git's own
 * cache-tree check is never gated by `--no-full` or `--connectivity-only`
 * either — a chmod'd pack still fails it under `--no-full`, and a healthy
 * one still passes it. Never reads the object's own bytes — the same
 * bounded presence probe `refs-verify.ts`'s `isKnownOid` performs for the
 * identical reason.
 */
async function existsInStore(ctx: Context, id: ObjectId): Promise<boolean> {
  if (await probeLooseOid(ctx, id)) return true;
  return (await getPackRegistry(ctx).lookup(id)) !== undefined;
}

/** Add every resolvable ref's target to `roots`. */
async function addRefRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<void> {
  const refNames = await enumerateRefs(ctx);
  for (const ref of refNames) {
    try {
      // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
      const id = await resolveRef(ctx, ref, { peel: false });
      // Only add to roots if the OID is present in the universe.
      // Absent OIDs are reported as bad-ref(badRefOid) by the refs-verify pass
      // and must NOT be added to roots (would produce spurious 'missing' findings).
      if (universe.has(id)) roots.add(id);
    } catch {
      // Unresolvable ref (unborn, dangling symref, malformed content) — tolerated
    }
  }
}

async function addReflogRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  const reflogNames = await listReflogs(ctx);
  await Promise.all(
    reflogNames.map(async (ref) => {
      try {
        const entries = await readReflog(ctx, ref);
        for (const entry of entries) {
          // ZERO_OID is the "no object" sentinel git writes for creation events
          // (first reflog entry of any ref). It is not a real object reference
          // and must never be treated as a reachability root.
          if (entry.oldId !== ZERO_OID) roots.add(entry.oldId);
          if (entry.newId !== ZERO_OID) roots.add(entry.newId);
        }
      } catch {
        // Unreadable reflog — tolerated
      }
    }),
  );
}

/**
 * Whether `entry` or any of its descendants names a tree oid that fails to
 * resolve — git's own `fsck_cache_tree` walks every cache-tree entry this
 * same way. An invalidated entry (`id` absent) carries nothing to resolve
 * and is skipped, but its children are still walked (invalidation is
 * per-entry, not inherited by exclusion from the check).
 */
async function cacheTreeUnresolved(ctx: Context, entry: CacheTreeEntry): Promise<boolean> {
  if (entry.id !== undefined && !(await existsInStore(ctx, entry.id))) return true;
  for (const child of entry.children) {
    if (await cacheTreeUnresolved(ctx, child)) return true;
  }
  return false;
}

/**
 * Add every stage-0 index entry's oid to `roots`, then report whether the
 * index's cache-tree (`TREE` extension) — if it has one — carries an
 * unresolvable tree oid. Called only when `indexRoot !== false` — that
 * option means "the index does not participate in this fsck run" for both
 * of the index's roles (reachability root source and cache-tree check
 * alike), so disabling it skips the whole read rather than consulting the
 * index behind the option's back.
 *
 * Measured against git 2.55.0: neither ref resolution nor the reflog has
 * any bearing on this check — it is driven purely by the index's own
 * cache-tree. An index with no `TREE` extension (including no index at
 * all) contributes nothing, matching git, which runs no such check there.
 */
async function addIndexRoots(ctx: Context, roots: Set<ObjectId>): Promise<boolean> {
  let cacheTreeBroken = false;
  try {
    const index = await readIndex(ctx);
    for (const entry of index.entries) {
      if (entry.flags.stage !== 0) continue;
      roots.add(entry.id);
    }
    const cacheTreeExtension = index.extensions.find(
      (ext) => ext.signature === CACHE_TREE_SIGNATURE,
    );
    if (cacheTreeExtension !== undefined) {
      cacheTreeBroken = await cacheTreeUnresolved(ctx, parseCacheTree(cacheTreeExtension.data));
    }
  } catch {
    // Missing or corrupt index (or cache-tree) — tolerated
  }
  return cacheTreeBroken;
}

export interface RootsCollection {
  readonly roots: ReadonlySet<ObjectId>;
  /**
   * The repository-wide condition `fsck`'s missing-entry-point rule (bit 8)
   * fires on: the index carries a cache-tree (`TREE` extension) AND at
   * least one of its entries' tree oids fails to resolve. No index, or an
   * index with no cache-tree extension, never sets this — vacuous absence
   * is not a fault. Ref and reflog resolution have no bearing on this bit.
   */
  readonly missingEntryPoint: boolean;
}

/**
 * Collect all oids that serve as reachability roots:
 * - Each resolved ref (HEAD + all refs/*)
 * - Reflog old/new oids (when reflogRoots !== false)
 * - Index entry oids (when indexRoot !== false)
 *
 * Alongside the roots, reports the missing-entry-point condition — computed
 * from the same index read `addIndexRoots` already does for reachability, no
 * re-scan of the store beyond the bounded per-oid existence probe the
 * cache-tree check itself needs.
 */
export async function collectRoots(
  ctx: Context,
  opts: FsckOptions,
  universe: ReadonlySet<ObjectId>,
): Promise<RootsCollection> {
  const roots = new Set<ObjectId>();
  await addRefRoots(ctx, roots, universe);
  if (opts.reflogRoots !== false) await addReflogRoots(ctx, roots);
  const missingEntryPoint = opts.indexRoot !== false ? await addIndexRoots(ctx, roots) : false;
  return { roots, missingEntryPoint };
}

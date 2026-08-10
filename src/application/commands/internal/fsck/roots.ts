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

/**
 * Whether `id` genuinely exists and is accessible — a loose-then-pack
 * existence probe, deliberately INDEPENDENT of `universe` membership:
 * `universe` is narrowed for reasons that have nothing to do with object
 * health (`full: false` excludes packs outright as a scan-depth choice;
 * `connectivityOnly` widens it to admit an oid whose housing pack later
 * fails its own header gate). Measured against git 2.55.0: git's own
 * cache-tree/ref-resolution check is never gated by `--no-full` or
 * `--connectivity-only` either — a chmod'd pack still fails it under
 * `--no-full`, and a healthy one still passes it. Never reads the object's
 * own bytes — the same bounded presence probe `refs-verify.ts`'s
 * `isKnownOid` performs for the identical reason.
 */
async function existsInStore(ctx: Context, id: ObjectId): Promise<boolean> {
  if (await probeLooseOid(ctx, id)) return true;
  return (await getPackRegistry(ctx).lookup(id)) !== undefined;
}

/**
 * Add every resolvable ref's target to `roots` and report whether at least
 * one ref resolved to a readable object — one of the two entry-point
 * sources `fsck`'s missing-entry-point rule inspects.
 */
async function addRefRoots(
  ctx: Context,
  roots: Set<ObjectId>,
  universe: ReadonlySet<ObjectId>,
): Promise<boolean> {
  const refNames = await enumerateRefs(ctx);
  let resolved = false;
  for (const ref of refNames) {
    try {
      // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
      const id = await resolveRef(ctx, ref, { peel: false });
      // Only add to roots if the OID is present in the universe.
      // Absent OIDs are reported as bad-ref(badRefOid) by the refs-verify pass
      // and must NOT be added to roots (would produce spurious 'missing' findings).
      if (universe.has(id)) roots.add(id);
      // Once one ref resolves, further probes cannot change the verdict —
      // skip them rather than probing every remaining ref for nothing.
      if (!resolved && (await existsInStore(ctx, id))) resolved = true;
    } catch {
      // Unresolvable ref (unborn, dangling symref, malformed content) — tolerated
    }
  }
  return resolved;
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

/** The index half of the entry-point tally: whether the index carries any
 *  stage-0 entry at all (`hasEntries`), and whether at least one of those
 *  entries resolved to a readable object (`resolved`). Kept apart from a
 *  plain boolean because an ABSENT index and a PRESENT-but-fully-broken one
 *  must read differently to `fsck`'s missing-entry-point rule: an absent
 *  index is not a fault (a bare or never-staged repository is healthy), a
 *  present one whose every entry fails to resolve is. */
interface IndexRootsTally {
  readonly hasEntries: boolean;
  readonly resolved: boolean;
}

/**
 * Add every stage-0 index entry's oid to `roots` and report the entry-point
 * tally from the same read. Called only when `indexRoot !== false` — that
 * option means "the index does not participate in this fsck run" for both
 * of the index's roles (reachability root source and entry-point source
 * alike), so disabling it makes the entry-point condition fall back to its
 * vacuous default (`hasEntries: false`) rather than silently consulting the
 * index behind the option's back.
 *
 * Measured against git 2.55.0: a repository's reflog makes NO observable
 * difference to git's own missing-entry-point bit (a bare repo with reflog
 * entries that all fail to resolve, and the same fixture with its reflog
 * removed entirely, both leave the bit unset) — the bit tracks the index's
 * cache-tree instead, present only once a working tree has been populated.
 * `readIndex`'s stage-0 entries are the closest primitive tsgit already has
 * to that structure.
 */
async function addIndexRoots(ctx: Context, roots: Set<ObjectId>): Promise<IndexRootsTally> {
  let hasEntries = false;
  let resolved = false;
  try {
    const index = await readIndex(ctx);
    for (const entry of index.entries) {
      if (entry.flags.stage !== 0) continue;
      hasEntries = true;
      roots.add(entry.id);
      // Same short-circuit as `addRefRoots` — one resolving entry settles it.
      if (!resolved && (await existsInStore(ctx, entry.id))) resolved = true;
    }
  } catch {
    // Missing or corrupt index — tolerated
  }
  return { hasEntries, resolved };
}

const NO_INDEX_TALLY: IndexRootsTally = { hasEntries: false, resolved: false };

export interface RootsCollection {
  readonly roots: ReadonlySet<ObjectId>;
  /**
   * The repository-wide condition `fsck`'s missing-entry-point rule (bit 8)
   * fires on: no ref resolved to a readable object, AND the index carries at
   * least one entry, AND none of those entries resolved either. A
   * repository with no index at all (no working tree ever populated) never
   * sets this, regardless of ref resolution — vacuous absence is not a
   * fault. Reflog entries are not part of this condition — measured against
   * git 2.55.0, reflog resolution has no effect on the bit.
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
 * from the SAME ref/index walk, no re-scan of the store beyond the bounded
 * per-target existence probe every already-resolved candidate needs anyway.
 */
export async function collectRoots(
  ctx: Context,
  opts: FsckOptions,
  universe: ReadonlySet<ObjectId>,
): Promise<RootsCollection> {
  const roots = new Set<ObjectId>();
  const refsResolved = await addRefRoots(ctx, roots, universe);
  if (opts.reflogRoots !== false) await addReflogRoots(ctx, roots);
  const index = opts.indexRoot !== false ? await addIndexRoots(ctx, roots) : NO_INDEX_TALLY;
  const missingEntryPoint = !refsResolved && index.hasEntries && !index.resolved;
  return { roots, missingEntryPoint };
}

import type { ObjectId } from '../../../../domain/objects/index.js';
import { ZERO_OID } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { readIndex } from '../../../primitives/read-index.js';
import { listReflogs, readReflog } from '../../../primitives/reflog-store.js';
import { resolveRef } from '../../../primitives/resolve-ref.js';
import type { FsckOptions } from './types.js';

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

async function addIndexRoots(ctx: Context, roots: Set<ObjectId>): Promise<void> {
  try {
    const index = await readIndex(ctx);
    for (const entry of index.entries) {
      if (entry.flags.stage === 0) roots.add(entry.id);
    }
  } catch {
    // Missing or corrupt index — tolerated
  }
}

/**
 * Collect all oids that serve as reachability roots:
 * - Each resolved ref (HEAD + all refs/*)
 * - Reflog old/new oids (when reflogRoots !== false)
 * - Index entry oids (when indexRoot !== false)
 */
export async function collectRoots(
  ctx: Context,
  opts: FsckOptions,
  universe: ReadonlySet<ObjectId>,
): Promise<ReadonlySet<ObjectId>> {
  const roots = new Set<ObjectId>();
  await addRefRoots(ctx, roots, universe);
  if (opts.reflogRoots !== false) await addReflogRoots(ctx, roots);
  if (opts.indexRoot !== false) await addIndexRoots(ctx, roots);
  return roots;
}

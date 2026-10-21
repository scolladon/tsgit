import { errorDataCode } from '../../../../domain/error-data-code.js';
import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import { invalidObjectHeader } from '../../../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../../../domain/objects/index.js';
import { invalidPackEntry } from '../../../../domain/storage/error.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { readObject } from '../../../primitives/read-object.js';
import { resolveRef } from '../../../primitives/resolve-ref.js';
import { type CachedGitObject, packedLocationOf } from './object-cache.js';
import { looseHolderPath } from './object-presence.js';
import { isTolerableRefFault } from './roots.js';
import { isStoredCorruption } from './stored-corruption.js';

async function tipOf(ctx: Context, ref: RefName): Promise<ObjectId | undefined> {
  try {
    // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
    return await resolveRef(ctx, ref, { peel: false });
  } catch (err) {
    if (!isTolerableRefFault(err)) throw err;
    return undefined;
  }
}

/** The codes a loose file fails with when git's own read of it cannot
 *  inflate it or parse its header — the faults its loose reader dies on. */
const LOOSE_UNREADABLE_CODES: ReadonlySet<string | undefined> = new Set([
  'DECOMPRESS_FAILED',
  'INVALID_OBJECT_HEADER',
  'LOOSE_OBJECT_CORRUPT',
]);

/** git's die for an object it cannot read: a pack claiming it is
 *  `has_packed_and_bad`; otherwise a loose file it cannot unpack. */
async function corruptionDie(ctx: Context, id: ObjectId, err: unknown): Promise<Error | undefined> {
  const location = await packedLocationOf(ctx, id);
  if (location !== undefined)
    return invalidPackEntry(
      location.offset,
      `packed object ${id} (stored in ${location.pack}) is corrupt`,
    );
  if (!LOOSE_UNREADABLE_CODES.has(errorDataCode(err))) return undefined;
  const path = await looseHolderPath(ctx, id);
  return path === undefined
    ? undefined
    : invalidObjectHeader(`loose object ${id} (stored in ${path}) is corrupt`);
}

/** Refuse when `id` cannot be read and a store holds it — git's die on a
 *  packed or loose copy it cannot read; an id no store holds is git's
 *  `invalid sha1 pointer`, reported elsewhere. */
async function assertReadableUnlessAbsent(ctx: Context, id: ObjectId): Promise<void> {
  try {
    await readObject(ctx, id);
  } catch (err) {
    if (!isStoredCorruption(err)) throw err;
    const die = await corruptionDie(ctx, id, err);
    if (die !== undefined) throw die;
  }
}

/** git's die for every one of `ids` it parses: an id the audit's object
 *  cache already decoded is readable — only the rest are read. */
export async function assertObjectsReadable(
  ctx: Context,
  ids: Iterable<ObjectId>,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
): Promise<void> {
  for (const id of ids) {
    if ((cache.get(id) ?? null) !== null) continue;
    await assertReadableUnlessAbsent(ctx, id);
  }
}

/**
 * git's `snapshot_ref` parses every ref tip before any check runs, in every
 * mode; a tip whose only copy is a damaged pack entry dies there.
 */
export async function assertRefTipsReadable(
  ctx: Context,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
): Promise<void> {
  await assertObjectsReadable(ctx, await refTips(ctx), cache);
}

/** Every ref's own tip, in ref order — a ref naming nothing is skipped. */
export async function refTips(ctx: Context): Promise<ReadonlyArray<ObjectId>> {
  const tips: ObjectId[] = [];
  for (const ref of await enumerateRefs(ctx)) {
    const id = await tipOf(ctx, ref);
    if (id !== undefined) tips.push(id);
  }
  return tips;
}

/** The stored types `--connectivity-only`'s walk parses: every one but a blob's. */
const PARSED_BY_WALK: ReadonlySet<FsckObjectType> = new Set(['commit', 'tree', 'tag']);

/**
 * `--connectivity-only` parses every reachable commit, tree and tag as it
 * walks — never a blob — so one whose only copy is a damaged pack entry dies
 * there. `storedTypes` types the unreadable ones from their entry headers.
 */
export async function assertWalkedObjectsReadable(
  ctx: Context,
  reached: ReadonlySet<ObjectId>,
  storedTypes: ReadonlyMap<ObjectId, FsckObjectType>,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
): Promise<void> {
  const parsed = [...reached].filter((id) => PARSED_BY_WALK.has(storedTypes.get(id) ?? 'blob'));
  await assertObjectsReadable(ctx, parsed, cache);
}

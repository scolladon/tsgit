import { applyGraft } from '../../../../domain/commit/graft.js';
import { errorDataCode } from '../../../../domain/error-data-code.js';
import { parseObject } from '../../../../domain/objects/git-object.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { loadShallowSet } from '../../../primitives/internal/shallow-set.js';
import { readObject } from '../../../primitives/read-object.js';
import { type CachedGitObject, project } from './object-cache.js';
import { looseCopiesOf } from './object-presence.js';
import { isStoredCorruption } from './stored-corruption.js';

/**
 * Whether git's `parse_object` gets past `id`'s hash check on the copy the
 * store serves first: bytes that hash to another id are refused. Any other
 * damage is left to the readability assertion, which dies where git's read
 * dies.
 */
export async function hashesToItsId(ctx: Context, id: ObjectId): Promise<boolean> {
  try {
    await readObject(ctx, id, { verifyHash: true });
    return true;
  } catch (err) {
    if (!isStoredCorruption(err)) throw err;
    return errorDataCode(err) !== 'OBJECT_HASH_MISMATCH';
  }
}

/** Whether git's `parse_object` gets past an id's hash check, each id read once. */
export type ParseCheck = (id: ObjectId) => Promise<boolean>;

/** `hashesToItsId` remembered per id, so every ref pass shares one read of a tip. */
export function parseCheckOnce(ctx: Context): ParseCheck {
  const verdicts = new Map<ObjectId, Promise<boolean>>();
  return (id) => {
    const known = verdicts.get(id);
    if (known !== undefined) return known;
    const verdict = hashesToItsId(ctx, id);
    verdicts.set(id, verdict);
    return verdict;
  };
}

/** One loose copy as `fsck_loose` reads it, or `undefined` when it fails to
 *  inflate, hash to `id` or parse — git then marks nothing it names used. A
 *  shallow commit's parents are cut, as git's parse grafts them. */
async function verifiedCopy(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  shallow: ReadonlySet<ObjectId>,
): Promise<CachedGitObject | undefined> {
  try {
    const raw = await ctx.compressor.inflate(compressed);
    const hasher = ctx.hash.createHasher();
    hasher.update(raw);
    if ((await hasher.digestHex()) !== id) return undefined;
    const parsed = parseObject(id, raw, ctx.hashConfig);
    return project(parsed.type === 'commit' ? applyGraft(parsed, shallow) : parsed);
  } catch (err) {
    if (!isStoredCorruption(err)) throw err;
    return undefined;
  }
}

/** The first loose copy of `id` that passes git's checks, or `null`. */
async function firstVerifiedLooseCopy(
  ctx: Context,
  id: ObjectId,
  shallow: ReadonlySet<ObjectId>,
): Promise<CachedGitObject> {
  for (const { compressed } of await looseCopiesOf(ctx, id)) {
    const copy = await verifiedCopy(ctx, id, compressed, shallow);
    if (copy !== undefined) return copy;
  }
  return null;
}

/** Whether a loose copy of `id` passes git's checks: a fallback for a pack entry git cannot unpack. */
export async function hasVerifiedLooseCopy(ctx: Context, id: ObjectId): Promise<boolean> {
  const copy = await firstVerifiedLooseCopy(ctx, id, await loadShallowSet(ctx));
  return copy !== null;
}

/**
 * For each id whose served copy is a mis-hashed pack entry, the copy git's
 * `fsck_obj` verified instead: the first loose copy that passes its hash,
 * or `null` when none does — git then never records the object as held.
 */
export async function verifiedCopiesOf(
  ctx: Context,
  misHashed: ReadonlySet<ObjectId>,
): Promise<ReadonlyMap<ObjectId, CachedGitObject>> {
  const verified = new Map<ObjectId, CachedGitObject>();
  const shallow = await loadShallowSet(ctx);
  for (const id of misHashed) {
    if (await hashesToItsId(ctx, id)) continue;
    verified.set(id, await firstVerifiedLooseCopy(ctx, id, shallow));
  }
  return verified;
}

/** The ids no copy of which passed git's checks. */
export function unverifiedIds(
  verified: ReadonlyMap<ObjectId, CachedGitObject>,
): ReadonlySet<ObjectId> {
  return new Set([...verified].flatMap(([id, copy]) => (copy === null ? [id] : [])));
}

/** `cache` with each verified copy in place of the one the store serves. */
export function withVerifiedCopies(
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
  verified: ReadonlyMap<ObjectId, CachedGitObject>,
): ReadonlyMap<ObjectId, CachedGitObject> {
  return verified.size === 0 ? cache : new Map([...cache, ...verified]);
}

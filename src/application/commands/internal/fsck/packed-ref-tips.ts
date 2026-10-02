import { errorDataCode } from '../../../../domain/error-data-code.js';
import type { FsckObjectType } from '../../../../domain/fsck/index.js';
import type { ObjectId, RefName } from '../../../../domain/objects/index.js';
import { invalidPackEntry } from '../../../../domain/storage/error.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { readObject } from '../../../primitives/read-object.js';
import { resolveRef } from '../../../primitives/resolve-ref.js';
import { type CachedGitObject, packedLocationOf } from './object-cache.js';
import { isTolerableRefFault } from './roots.js';
import type { FsckFinding } from './types.js';

async function tipOf(ctx: Context, ref: RefName): Promise<ObjectId | undefined> {
  try {
    return await resolveRef(ctx, ref, { peel: false });
  } catch (err) {
    if (!isTolerableRefFault(err)) throw err;
    return undefined;
  }
}

const packKey = (pack: string, objectsDir: string | undefined): string =>
  `${objectsDir ?? ''}\0${pack}`;

/**
 * Packs whose `.rev` disagrees with their `.idx`. tsgit bounds an entry read
 * by the `.rev`; git inflates without it, so a read failure there says
 * nothing about the entry itself and must not become git's fatal.
 */
export function packsWithWrongRevIndex(findings: ReadonlyArray<FsckFinding>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const f of findings) {
    if (f.type !== 'pack-rev-index-invalid' && f.type !== 'pack-rev-index-position-mismatch')
      continue;
    keys.add(packKey(f.pack, f.objectsDir));
  }
  return keys;
}

/** The codes a read of a damaged stored entry fails with: an unusable entry
 *  or the index routing to it,
 *  delta chain, zlib stream or header, a body that no longer parses, a body that no longer hashes to its id,
 *  or a delta base the pack no longer yields. Anything else — a permission or
 *  I/O fault — says nothing about the entry and must reach the caller as-is. */
const CORRUPTION_CODES: ReadonlySet<string | undefined> = new Set([
  'INVALID_PACK_ENTRY',
  'INVALID_PACK_HEADER',
  'INVALID_PACK_INDEX',
  'INVALID_MULTI_PACK_INDEX',
  'INVALID_PACK_REV_INDEX',
  'INVALID_DELTA',
  'DELTA_CHAIN_TOO_DEEP',
  'DECOMPRESS_FAILED',
  'INVALID_OBJECT_HEADER',
  'INVALID_TREE_ENTRY',
  'INVALID_COMMIT',
  'INVALID_TAG',
  'INVALID_FILE_MODE',
  'INVALID_IDENTITY',
  'OBJECT_HASH_MISMATCH',
  'OBJECT_NOT_FOUND',
]);

/** Refuse when `id` cannot be read and a pack claims it — git's die on a
 *  `has_packed_and_bad` object; an id no store claims is git's
 *  `invalid sha1 pointer`, reported elsewhere. */
async function assertReadableUnlessAbsent(
  ctx: Context,
  id: ObjectId,
  wrongRevPacks: ReadonlySet<string>,
): Promise<void> {
  try {
    await readObject(ctx, id);
  } catch (err) {
    if (!CORRUPTION_CODES.has(errorDataCode(err))) throw err;
    const location = await packedLocationOf(ctx, id);
    if (location === undefined) return;
    if (wrongRevPacks.has(packKey(location.pack, location.attribution.objectsDir))) return;
    throw invalidPackEntry(
      location.offset,
      `packed object ${id} (stored in ${location.pack}) is corrupt`,
    );
  }
}

/** git's die for every one of `ids` it parses: an id the audit's object
 *  cache already decoded is readable — only the rest are read. */
export async function assertObjectsReadable(
  ctx: Context,
  ids: Iterable<ObjectId>,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
  wrongRevPacks: ReadonlySet<string>,
): Promise<void> {
  for (const id of ids) {
    if ((cache.get(id) ?? null) !== null) continue;
    await assertReadableUnlessAbsent(ctx, id, wrongRevPacks);
  }
}

/**
 * git's `snapshot_ref` parses every ref tip before any check runs, in every
 * mode; a tip whose only copy is a damaged pack entry dies there.
 */
export async function assertRefTipsReadable(
  ctx: Context,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
  wrongRevPacks: ReadonlySet<string>,
): Promise<void> {
  const tips: ObjectId[] = [];
  for (const ref of await enumerateRefs(ctx)) {
    const id = await tipOf(ctx, ref);
    if (id !== undefined) tips.push(id);
  }
  await assertObjectsReadable(ctx, tips, cache, wrongRevPacks);
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
  wrongRevPacks: ReadonlySet<string>,
): Promise<void> {
  const parsed = [...reached].filter((id) => PARSED_BY_WALK.has(storedTypes.get(id) ?? 'blob'));
  await assertObjectsReadable(ctx, parsed, cache, wrongRevPacks);
}

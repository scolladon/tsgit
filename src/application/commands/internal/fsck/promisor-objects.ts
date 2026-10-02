import type { ObjectId } from '../../../../domain/objects/index.js';
import { objectIdAt } from '../../../../domain/storage/index.js';
import type { Context } from '../../../../ports/context.js';
import { readPromisorRemoteNames } from '../../../primitives/config-read.js';
import { deriveContext } from '../../../primitives/derive-context.js';
import { packPositionMap } from '../../../primitives/internal/pack-positions.js';
import { getObjectStore } from '../../../primitives/object-store.js';
import type { RegisteredPack } from '../../../primitives/pack-registry.js';
import { readObject } from '../../../primitives/read-object.js';
import { type CachedGitObject, type ProjectedGitObject, project } from './object-cache.js';
import { isStoredCorruption } from './stored-corruption.js';

const NO_PROMISOR_OBJECTS: ReadonlySet<ObjectId> = new Set();

/** git's fsck sets `fetch_if_missing = 0`: it audits what the store holds
 *  and never asks a promisor remote for the rest. */
export function withoutLazyFetch(ctx: Context): Context {
  const { promisor: _promisor, ...rest } = ctx;
  return deriveContext(rest, {});
}

/** git's `repo_has_promisor_remote`. */
async function hasPromisorRemote(ctx: Context): Promise<boolean> {
  return (await readPromisorRemoteNames(ctx)).length > 0;
}

/** Every `.promisor`-marked pack, source by source — a kept one included. */
async function promisorPacks(ctx: Context): Promise<ReadonlyArray<RegisteredPack>> {
  const packs: RegisteredPack[] = [];
  for (const { registry } of (await getObjectStore(ctx)).sources) {
    const fileNames = await registry.fileNames();
    for (const pack of await registry.all()) {
      if (fileNames.has(`${pack.name}.promisor`)) packs.push(pack);
    }
  }
  return packs;
}

async function* inPackOrder(packs: ReadonlyArray<RegisteredPack>): AsyncGenerator<ObjectId> {
  for (const pack of packs) {
    const index = await pack.index();
    for (const position of packPositionMap(index)) yield objectIdAt(index, position);
  }
}

/** The oids an object points at — git's `add_promisor_object` fan-out. */
function pointedAt(obj: ProjectedGitObject): ReadonlyArray<ObjectId> {
  switch (obj.type) {
    case 'tree':
      return obj.entries.map((entry) => entry.id);
    case 'commit':
      return [obj.tree, ...obj.parents];
    case 'tag':
      return [obj.object];
    case 'blob':
      return [];
  }
}

/** The audit's own decoding when it read `id`; a direct read when it did not
 *  (`--no-full` verifies no pack). */
async function projectionOf(
  ctx: Context,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  id: ObjectId,
): Promise<CachedGitObject> {
  const cached = objectCache.get(id);
  return cached === undefined ? parsedOrNull(ctx, id) : cached;
}

/** git's `parse_object` on an object the run never read: `null` when its
 *  copy does not read, parse or hash to `id`. */
async function parsedOrNull(ctx: Context, id: ObjectId): Promise<CachedGitObject> {
  try {
    return project(await readObject(ctx, id, { verifyHash: true }));
  } catch (err) {
    if (!isStoredCorruption(err)) throw err;
    return null;
  }
}

/**
 * git's `is_promisor_object` set: every object a promisor pack holds and every
 * object those point at — empty without a promisor remote. Built in pack
 * order, and cut short at the first object git cannot parse, as git's
 * `for_each_object_in_pack` stops when `add_promisor_object` fails.
 */
export async function collectPromisorObjects(
  ctx: Context,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): Promise<ReadonlySet<ObjectId>> {
  if (!(await hasPromisorRemote(ctx))) return NO_PROMISOR_OBJECTS;
  const promised = new Set<ObjectId>();
  for await (const id of inPackOrder(await promisorPacks(ctx))) {
    const obj = await projectionOf(ctx, objectCache, id);
    if (obj === null) break;
    promised.add(id);
    for (const target of pointedAt(obj)) promised.add(target);
  }
  return promised;
}

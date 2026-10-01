/**
 * git's `odb_freshen_object`: before writing an object, ask every object
 * source whether it already holds a copy and, if so, set that file's times to
 * now instead of writing a duplicate. No bytes are written.
 *
 * @writes
 *   surface: objectFreshen
 *   kind:    equivalent-under-readback
 *   format:  utime-now
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import {
  getObjectStore,
  looseCacheLocation,
  type ObjectSource,
  type ObjectStore,
} from '../object-store.js';
import type { RegisteredPack } from '../pack-registry.js';
import { looseObjectPathIn, packsDirIn } from '../path-layout.js';
import { probeLooseOid } from './loose-oid-cache.js';

/** git's `packed_git.freshened`: a pack's `.pack` is touched once per pack instance. */
const freshenedPacks = new WeakSet<RegisteredPack>();

const touch = async (ctx: Context, source: ObjectSource, path: string): Promise<boolean> => {
  const { utimeNow } = source.fs;
  if (utimeNow === undefined) return false;
  try {
    await utimeNow.call(source.fs, path);
    return true;
  } catch (error) {
    const code = errorDataCode(error);
    if (code === undefined) throw error;
    ctx.logger?.debug?.('objectStore: freshen refused', { path, code });
    return false;
  }
};

/** `undefined` means the pack arm has no verdict and the loose arm decides. */
const freshenPacked = async (
  ctx: Context,
  source: ObjectSource,
  id: ObjectId,
): Promise<boolean | undefined> => {
  const hit = await source.registry.lookup(id);
  if (hit === undefined) return undefined;
  if ((await source.registry.fileNames()).has(`${hit.pack.name}.mtimes`)) return undefined;
  if (freshenedPacks.has(hit.pack)) return true;
  const touched = await touch(
    ctx,
    source,
    `${packsDirIn(source.objectsDir)}/${hit.pack.name}.pack`,
  );
  if (touched) freshenedPacks.add(hit.pack);
  return touched ? true : undefined;
};

const freshenLoose = async (
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
  id: ObjectId,
): Promise<boolean> => {
  if (!(await probeLooseOid(ctx, id, looseCacheLocation(store, source)))) return false;
  return touch(ctx, source, looseObjectPathIn(source.objectsDir, id));
};

export async function freshenObject(ctx: Context, id: ObjectId): Promise<boolean> {
  const store = await getObjectStore(ctx);
  for (const source of store.sources) {
    await source.registry.assertLoadable();
    if ((await freshenPacked(ctx, source, id)) === true) return true;
    if (await freshenLoose(ctx, store, source, id)) return true;
  }
  return false;
}

/** The freshen git's `access(F_OK)` performs when a racing writer already created the loose file. */
export async function touchLooseCopy(ctx: Context, path: string): Promise<void> {
  const store = await getObjectStore(ctx);
  await touch(ctx, store.primary, path);
}

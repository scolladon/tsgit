import type { ObjectId } from '../../../../domain/objects/index.js';
import { lookupPackIndex } from '../../../../domain/storage/index.js';
import type { Context } from '../../../../ports/context.js';
import { probeLooseOid } from '../../../primitives/internal/loose-oid-cache.js';
import {
  looseCacheLocation,
  type ObjectSource,
  type ObjectStore,
} from '../../../primitives/object-store.js';
import type { PackLookupHit, RegisteredPack } from '../../../primitives/pack-registry.js';
import { refTips } from './packed-ref-tips.js';
import { isContainedLookupFault, worktreeHeads } from './roots.js';

/** Where one ref tip resolved in a source's packed store, as git's `find_pack_entry` meets it. */
export type TipHit =
  | { readonly kind: 'midx'; readonly pack: string }
  | { readonly kind: 'scan'; readonly holders: ReadonlySet<string> };

interface OrderablePack {
  readonly name: string;
  readonly seconds: number;
}

/** git's `sort_pack` within one source: the youngest first, ties kept in place. */
const youngestFirst = <P extends OrderablePack>(packs: ReadonlyArray<P>): ReadonlyArray<P> =>
  [...packs].sort((left, right) => right.seconds - left.seconds);

/** A midx hit loads its pack, appended once. */
function loadMidxPack<P extends OrderablePack>(
  list: ReadonlyArray<P>,
  midx: ReadonlyArray<P>,
  name: string,
): ReadonlyArray<P> {
  if (list.some((pack) => pack.name === name)) return list;
  const loaded = midx.find((pack) => pack.name === name);
  return loaded === undefined ? list : [...list, loaded];
}

/** A scan hit moves the first holder in the current order to the front. */
function moveFirstHolderToFront<P extends OrderablePack>(
  list: ReadonlyArray<P>,
  holders: ReadonlySet<string>,
): ReadonlyArray<P> {
  const at = list.findIndex((pack) => holders.has(pack.name));
  if (at < 0) return list;
  return [list[at] as P, ...list.slice(0, at), ...list.slice(at + 1)];
}

/**
 * One source's packs in the order git's fsck verifies them. git sorts the
 * packs its directory scan loaded — never the multi-pack-index's — youngest
 * first; `snapshot_refs` then reads every ref tip, which moves a scanned
 * holder to the front and loads a midx-claimed pack at the back; the
 * re-prepare re-sorts that list, and the midx packs no tip loaded follow in
 * pack-int-id order, unsorted.
 */
export function orderPacksForVerify<P extends OrderablePack>(
  scanned: ReadonlyArray<P>,
  midx: ReadonlyArray<P>,
  hits: ReadonlyArray<TipHit>,
): ReadonlyArray<P> {
  const touched = hits.reduce<ReadonlyArray<P>>(
    (list, hit) =>
      hit.kind === 'midx'
        ? loadMidxPack(list, midx, hit.pack)
        : moveFirstHolderToFront(list, hit.holders),
    youngestFirst(scanned),
  );
  const loaded = new Set(touched.map(({ name }) => name));
  return [...youngestFirst(touched), ...midx.filter(({ name }) => !loaded.has(name))];
}

const MS_PER_SECOND = 1000;

interface StampedPack extends OrderablePack {
  readonly pack: RegisteredPack;
}

interface SourcePacks {
  readonly source: ObjectSource;
  readonly scanned: ReadonlyArray<StampedPack>;
  readonly midx: ReadonlyArray<StampedPack>;
}

async function stamp(source: ObjectSource, pack: RegisteredPack): Promise<StampedPack> {
  const { mtimeMs } = await source.fs.stat(pack.packPath);
  return { pack, name: pack.name, seconds: Math.floor(mtimeMs / MS_PER_SECOND) };
}

/** A source's accessible packs, split as git loads them: by directory scan or through the midx. */
async function sourcePacks(source: ObjectSource): Promise<SourcePacks> {
  const { accessible } = await source.registry.health();
  const stamped = await Promise.all(accessible.map((pack) => stamp(source, pack)));
  const midx = (await source.registry.midxPacks())
    .map(({ name }) => stamped.find((entry) => entry.name === name))
    .filter((entry) => entry !== undefined);
  return { source, scanned: stamped.filter((entry) => !midx.includes(entry)), midx };
}

async function scannedHolders(packs: SourcePacks, id: ObjectId): Promise<ReadonlySet<string>> {
  const holders = new Set<string>();
  for (const { pack, name } of packs.scanned) {
    if (lookupPackIndex(await pack.index(), id) !== undefined) holders.add(name);
  }
  return holders;
}

/** The store's own hit for `id`; a midx route the midx pass already reports
 *  as broken answers no hit, so the scanned packs are searched instead. */
async function midxRouteOf(packs: SourcePacks, id: ObjectId): Promise<PackLookupHit | undefined> {
  try {
    return await packs.source.registry.lookup(id);
  } catch (err) {
    if (!isContainedLookupFault(err)) throw err;
    return undefined;
  }
}

/** `id`'s hit in one source's packed store, else whether its loose store ends the lookup. */
async function hitIn(
  ctx: Context,
  store: ObjectStore,
  packs: SourcePacks,
  id: ObjectId,
): Promise<TipHit | 'loose' | undefined> {
  const hit = await midxRouteOf(packs, id);
  if (hit !== undefined && packs.midx.some(({ name }) => name === hit.pack.name)) {
    return { kind: 'midx', pack: hit.pack.name };
  }
  const holders = await scannedHolders(packs, id);
  if (holders.size > 0) return { kind: 'scan', holders };
  const loose = await probeLooseOid(ctx, id, looseCacheLocation(store, packs.source));
  return loose ? 'loose' : undefined;
}

/** The ids `snapshot_refs` parses before any pack is verified: every ref tip, then every worktree HEAD. */
async function snapshotTips(ctx: Context): Promise<ReadonlyArray<ObjectId>> {
  const heads = (await worktreeHeads(ctx)).map(({ id }) => id);
  return [...new Set([...(await refTips(ctx)), ...heads])];
}

/** Every source's packs in git's verify order — see `orderPacksForVerify`. */
export async function packsInVerifyOrder(
  ctx: Context,
  store: ObjectStore,
): Promise<ReadonlyMap<ObjectSource, ReadonlyArray<RegisteredPack>>> {
  const all = await Promise.all(store.sources.map(sourcePacks));
  const hits = new Map<ObjectSource, TipHit[]>(all.map(({ source }) => [source, []]));
  for (const id of await snapshotTips(ctx)) {
    for (const packs of all) {
      const hit = await hitIn(ctx, store, packs, id);
      if (hit === undefined) continue;
      if (hit !== 'loose') hits.get(packs.source)?.push(hit);
      break;
    }
  }
  return new Map(
    all.map(({ source, scanned, midx }) => [
      source,
      orderPacksForVerify(scanned, midx, hits.get(source) ?? []).map(({ pack }) => pack),
    ]),
  );
}

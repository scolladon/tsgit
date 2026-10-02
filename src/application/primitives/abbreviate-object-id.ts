/**
 * Unique object-id abbreviation as git computes it (`odb_find_abbrev_len`):
 * a base length from `core.abbrev` — or, when unset or `auto`, from the
 * approximate object count — then the shortest length from there on at which
 * no other object, loose or packed, in any object source shares the prefix.
 */
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { assertValidAbbrevConfig, readConfig } from './config-read.js';
import { assertEverySourceLoadable, getObjectStore, type ObjectSource } from './object-store.js';
import { scanLooseIn, scanPacksIn } from './resolve-oid-prefix.js';

/** git's `FALLBACK_DEFAULT_ABBREV`: the floor of the automatic length. */
const AUTO_ABBREV_FLOOR = 7;
const HEX_DIGIT_BITS = 2;

/** Index of the highest set bit; `0` for `0` and `1`, as git's `msb`. */
const mostSignificantBit = (value: number): number => Math.max(0, Math.floor(Math.log2(value)));

const autoLength = (packedCount: number): number => {
  const bits = mostSignificantBit(packedCount) + 1;
  return Math.max(AUTO_ABBREV_FLOOR, Math.ceil(bits / HEX_DIGIT_BITS));
};

/** Packed-object total over every source: git's approximation ignores loose objects. */
const countPackedObjects = async (sources: ReadonlyArray<ObjectSource>): Promise<number> => {
  let total = 0;
  for (const source of sources) {
    for (const pack of await source.registry.all()) total += (await pack.index()).objectCount;
  }
  return total;
};

const baseLength = async (ctx: Context, sources: ReadonlyArray<ObjectSource>): Promise<number> => {
  const configured = (await readConfig(ctx)).core?.abbrev;
  if (configured === 'full') return ctx.hashConfig.hexLength;
  if (typeof configured === 'number') return configured;
  return autoLength(await countPackedObjects(sources));
};

const commonPrefixLength = (left: string, right: string): number => {
  let length = 0;
  while (length < left.length && left[length] === right[length]) length++;
  return length;
};

const rivalsSharing = async (
  ctx: Context,
  sources: ReadonlyArray<ObjectSource>,
  id: ObjectId,
  length: number,
): Promise<ReadonlyArray<ObjectId>> => {
  const prefix = id.slice(0, length);
  const perSource = await Promise.all(
    sources.map((source) =>
      Promise.all([scanLooseIn(ctx, source, prefix), scanPacksIn(source, prefix)]),
    ),
  );
  return [...new Set<ObjectId>(perSource.flat(2))].filter((other) => other !== id);
};

export const abbreviateObjectId = async (ctx: Context, id: ObjectId): Promise<string> => {
  await assertValidAbbrevConfig(ctx);
  await assertEverySourceLoadable(ctx);
  const { sources } = await getObjectStore(ctx);
  const fullLength = ctx.hashConfig.hexLength;
  const base = Math.min(await baseLength(ctx, sources), fullLength);
  if (base === fullLength) return id;
  const rivals = await rivalsSharing(ctx, sources, id, base);
  const longestShared = Math.max(base - 1, ...rivals.map((rival) => commonPrefixLength(id, rival)));
  return id.slice(0, Math.min(longestShared + 1, fullLength));
};

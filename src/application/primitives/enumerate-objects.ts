import type { ObjectId } from '../../domain/objects/index.js';
import { allObjectIds } from '../../domain/storage/pack-index.js';
import type { Context } from '../../ports/context.js';
import { boundedMapFor } from './internal/concurrency.js';
import { getObjectStore, type ObjectSource } from './object-store.js';
import type { RegisteredPack } from './pack-registry.js';
import { fanoutDirIn } from './path-layout.js';

export interface EnumerateObjectsOptions {
  /** Include objects from pack files (default: true). */
  readonly includePacks?: boolean;
  /**
   * Restrict the pack half of the universe to packs whose header gate passes
   * (default: `false`). When `true`, the pack half comes from
   * `registry.health().accessible`, so a pack refused at the header gate
   * contributes no ids. This is `fsck`'s universe knob and **not** a general
   * filter — every other enumeration surface (git's `cat-file
   * --batch-all-objects`, `count-objects`) lists a refused pack's ids and
   * must keep doing so.
   */
  readonly accessiblePacksOnly?: boolean;
  /**
   * Which object stores contribute (default: `'all'`): the primary plus every
   * alternate, or `'local'` for the primary alone. Maintenance that owns and
   * rewrites objects (`gc`) must pass `'local'` — an alternate's objects are
   * never its to count or touch.
   */
  readonly scope?: 'all' | 'local';
}

export async function enumerateObjects(
  ctx: Context,
  opts?: EnumerateObjectsOptions,
): Promise<ReadonlyArray<ObjectId>> {
  const includePacks = opts?.includePacks !== false;
  const accessiblePacksOnly = opts?.accessiblePacksOnly === true;
  const store = await getObjectStore(ctx);
  const sources = opts?.scope === 'local' ? [store.primary] : store.sources;
  const ids = new Set<ObjectId>();

  for (const source of sources) {
    await collectLooseObjectIds(ctx, source, ids);
    if (includePacks) await collectSourcePackIds(source, accessiblePacksOnly, ids);
  }

  return [...ids].sort();
}

async function collectSourcePackIds(
  source: ObjectSource,
  accessiblePacksOnly: boolean,
  ids: Set<ObjectId>,
): Promise<void> {
  const packs = accessiblePacksOnly
    ? (await source.registry.health()).accessible
    : await source.registry.all();
  await collectPackedObjectIds(packs, ids);
}

const HEX_DIGITS = /^[0-9a-f]+$/;

/** Whether `suffix` is exactly `expectedLength` lowercase hex digits — a
 *  fanout entry's filename must satisfy this to be a real loose object.
 *  Anything else (`tmp_obj_XXXXXX` quarantine litter, a stray dotfile, a
 *  wrong-width name under a foreign hash algorithm) is not an oid and must
 *  never be synthesised into one: an unfiltered filename becomes a phantom
 *  oid that `gc` would cruft-candidate, pack, and then fail to read back
 *  (`OBJECT_NOT_FOUND`) at its own post-write verify, wedging every future
 *  run on the same repository. */
function isLooseObjectSuffix(suffix: string, expectedLength: number): boolean {
  return suffix.length === expectedLength && HEX_DIGITS.test(suffix);
}

/** One fanout prefix's loose object ids — the unit `collectLooseObjectIds`
 *  fans out across the `ioBound` pool, since each is an independent
 *  `exists`-then-`readdir` round trip against its own directory. */
async function collectPrefixObjectIds(
  ctx: Context,
  source: ObjectSource,
  prefix: string,
): Promise<ReadonlyArray<ObjectId>> {
  const dir = fanoutDirIn(source.objectsDir, prefix);
  if (!(await source.fs.exists(dir))) return [];
  const entries = await source.fs.readdir(dir);
  const suffixLength = ctx.hashConfig.hexLength - prefix.length;
  const ids: ObjectId[] = [];
  for (const entry of entries) {
    if (entry.isFile && isLooseObjectSuffix(entry.name, suffixLength)) {
      ids.push(`${prefix}${entry.name}` as ObjectId);
    }
  }
  return ids;
}

/**
 * One source's loose object ids in the order git's `for_each_loose_file_in_source`
 * meets them: fanout directory by directory, each in its listing order. Up
 * to 256 fanout directories, each its own `exists`-then-`readdir` round
 * trip — fanned out across the `ioBound` pool rather than walked serially,
 * since none of the 256 probes depends on another's result.
 */
export async function listLooseObjectIds(
  ctx: Context,
  source: ObjectSource,
): Promise<ReadonlyArray<ObjectId>> {
  const perPrefix = await boundedMapFor(ctx, 'ioBound', HEX_PREFIXES, (prefix) =>
    collectPrefixObjectIds(ctx, source, prefix),
  );
  return perPrefix.flat();
}

async function collectLooseObjectIds(
  ctx: Context,
  source: ObjectSource,
  ids: Set<ObjectId>,
): Promise<void> {
  for (const id of await listLooseObjectIds(ctx, source)) ids.add(id);
}

async function collectPackedObjectIds(
  packs: ReadonlyArray<RegisteredPack>,
  ids: Set<ObjectId>,
): Promise<void> {
  for (const pack of packs) {
    for (const id of allObjectIds(await pack.index())) {
      ids.add(id);
    }
  }
}

/** The 256 two-hex-digit prefixes that git uses as loose-object subdirectory names. */
const HEX_PREFIXES: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

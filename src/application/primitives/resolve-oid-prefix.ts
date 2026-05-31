/**
 * Abbreviated-oid resolution. Resolves a 4–40-hex object-id prefix to a full
 * `ObjectId` by scanning loose objects (name-based, `<2>/<38>`) and pack
 * indexes (fanout-bounded `findByPrefix`). A full 40-hex returns verbatim with
 * no scan; a non-oid string returns `undefined` so callers may fall through to
 * ref resolution. Used by the cherry-pick sequencer (git-written abbreviated
 * `todo` oids), the commit-ish ladder, and `rev-parse`.
 */
import { ambiguousOidPrefix } from '../../domain/commands/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { findByPrefix } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { objectsDir } from './path-layout.js';
import { getPackRegistry } from './read-object.js';

const FULL_OID = /^[0-9a-f]{40}$/;
const OID_PREFIX = /^[0-9a-f]{4,39}$/;
const LOOSE_NAME = /^[0-9a-f]{38}$/;

/** Max candidate oids embedded in an `AMBIGUOUS_OID_PREFIX` error payload. */
export const MAX_OID_PREFIX_CANDIDATES = 16;

/** Loose objects whose `<dir><name>` starts with `prefix` (name-based scan). */
const scanLoose = async (ctx: Context, prefix: string): Promise<ReadonlyArray<ObjectId>> => {
  const dir = objectsDir(ctx.layout.gitDir, prefix.slice(0, 2));
  if (!(await ctx.fs.exists(dir))) return [];
  const rest = prefix.slice(2);
  const found: ObjectId[] = [];
  for (const entry of await ctx.fs.readdir(dir)) {
    if (!entry.isFile) continue;
    if (!LOOSE_NAME.test(entry.name)) continue;
    if (!entry.name.startsWith(rest)) continue;
    found.push((prefix.slice(0, 2) + entry.name) as ObjectId);
  }
  return found;
};

/** Packed objects whose id starts with `prefix`, across every registered pack. */
const scanPacks = async (ctx: Context, prefix: string): Promise<ReadonlyArray<ObjectId>> => {
  const packs = await getPackRegistry(ctx).all();
  const found: ObjectId[] = [];
  for (const pack of packs) {
    for (const id of findByPrefix(pack.index, prefix)) found.push(id);
  }
  return found;
};

export const resolveOidPrefix = async (
  ctx: Context,
  prefix: string,
): Promise<ObjectId | undefined> => {
  if (FULL_OID.test(prefix)) return prefix as ObjectId;
  if (!OID_PREFIX.test(prefix)) return undefined;
  const [loose, packed] = await Promise.all([scanLoose(ctx, prefix), scanPacks(ctx, prefix)]);
  const unique = [...new Set<ObjectId>([...loose, ...packed])];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  throw ambiguousOidPrefix(prefix, unique.slice(0, MAX_OID_PREFIX_CANDIDATES));
};

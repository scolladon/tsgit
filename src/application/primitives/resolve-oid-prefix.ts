/**
 * Abbreviated-oid resolution. Resolves a 4-to-`hexLength - 1`-hex object-id
 * prefix to a full `ObjectId` by scanning loose objects (name-based,
 * `<2>/<hexLength - 2>`) and pack indexes (fanout-bounded `findByPrefix`). A
 * full-width oid (`hexLength` hex, per the repository's own `HashConfig`)
 * returns verbatim with no scan; a non-oid string returns `undefined` so
 * callers may fall through to ref resolution. Used by the cherry-pick
 * sequencer (git-written abbreviated `todo` oids), the commit-ish ladder, and
 * `rev-parse`.
 */
import { ambiguousOidPrefix } from '../../domain/commands/error.js';
import { isOid, type ObjectId } from '../../domain/objects/index.js';
import { findByPrefix } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir, objectsDir } from './path-layout.js';
import { getPackRegistry } from './read-object.js';

/** Lower bound of an abbreviated-oid prefix — independent of the repository's
 *  hash width (measured against real git: a 4-char prefix resolves under
 *  both SHA-1 and SHA-256). */
const MIN_OID_PREFIX_LENGTH = 4;

/** A prefix pattern spanning `[MIN_OID_PREFIX_LENGTH, hexLength - 1]` hex
 *  chars — anything matching the full `hexLength` width is a full oid,
 *  handled by the `isOid` fast path below, never routed here. */
const oidPrefixPattern = (hexLength: number): RegExp =>
  new RegExp(`^[0-9a-f]{${MIN_OID_PREFIX_LENGTH},${hexLength - 1}}$`);

/** Loose object filename width: the fanout directory takes the first 2 hex
 *  chars, so the on-disk filename holds the remaining `hexLength - 2`. */
const looseNamePattern = (hexLength: number): RegExp => new RegExp(`^[0-9a-f]{${hexLength - 2}}$`);

/** Max candidate oids embedded in an `AMBIGUOUS_OID_PREFIX` error payload. */
export const MAX_OID_PREFIX_CANDIDATES = 16;

/** Loose objects whose `<dir><name>` starts with `prefix` (name-based scan). */
const scanLoose = async (ctx: Context, prefix: string): Promise<ReadonlyArray<ObjectId>> => {
  const dir = objectsDir(commonGitDir(ctx), prefix.slice(0, 2));
  if (!(await ctx.fs.exists(dir))) return [];
  const rest = prefix.slice(2);
  const looseName = looseNamePattern(ctx.hashConfig.hexLength);
  const found: ObjectId[] = [];
  for (const entry of await ctx.fs.readdir(dir)) {
    if (!entry.isFile) continue;
    if (!looseName.test(entry.name)) continue;
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
    const index = await pack.index();
    for (const id of findByPrefix(index, prefix)) found.push(id);
  }
  return found;
};

export const resolveOidPrefix = async (
  ctx: Context,
  prefix: string,
): Promise<ObjectId | undefined> => {
  if (isOid(prefix, ctx.hashConfig)) return prefix as ObjectId;
  if (!oidPrefixPattern(ctx.hashConfig.hexLength).test(prefix)) return undefined;
  const [loose, packed] = await Promise.all([scanLoose(ctx, prefix), scanPacks(ctx, prefix)]);
  const unique = [...new Set<ObjectId>([...loose, ...packed])];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  throw ambiguousOidPrefix(prefix, unique.slice(0, MAX_OID_PREFIX_CANDIDATES));
};

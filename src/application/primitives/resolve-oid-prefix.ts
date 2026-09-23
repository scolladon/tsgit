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
import { isMissingFanoutDir } from './internal/loose-oid-cache.js';
import { commonGitDir, objectsDir } from './path-layout.js';
import { getPackRegistry, peekPackRegistry } from './read-object.js';

/** Lower bound of an abbreviated-oid prefix — independent of the repository's
 *  hash width (measured against real git: a 4-char prefix resolves under
 *  both SHA-1 and SHA-256). */
const MIN_OID_PREFIX_LENGTH = 4;

/** The two hash widths a repository's `HashConfig.hexLength` ever reports. */
const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;

/** A prefix pattern spanning `[MIN_OID_PREFIX_LENGTH, hexLength - 1]` hex
 *  chars — anything matching the full `hexLength` width is a full oid,
 *  handled by the `isOid` fast path below, never routed here. Built once per
 *  hash width at module load, keyed by `hexLength` — never rebuilt per call. */
const OID_PREFIX_PATTERNS: ReadonlyMap<number, RegExp> = new Map([
  [SHA1_HEX_LENGTH, new RegExp(`^[0-9a-f]{${MIN_OID_PREFIX_LENGTH},${SHA1_HEX_LENGTH - 1}}$`)],
  [SHA256_HEX_LENGTH, new RegExp(`^[0-9a-f]{${MIN_OID_PREFIX_LENGTH},${SHA256_HEX_LENGTH - 1}}$`)],
]);

/** Loose object filename width: the fanout directory takes the first 2 hex
 *  chars, so the on-disk filename holds the remaining `hexLength - 2`. Built
 *  once per hash width at module load, keyed by `hexLength`. */
const LOOSE_NAME_PATTERNS: ReadonlyMap<number, RegExp> = new Map([
  [SHA1_HEX_LENGTH, new RegExp(`^[0-9a-f]{${SHA1_HEX_LENGTH - 2}}$`)],
  [SHA256_HEX_LENGTH, new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH - 2}}$`)],
]);

/** Looks up this repository's pattern by its own `hexLength` — every
 *  `HashConfig` in this codebase reports one of the two module-level widths,
 *  so a missing entry can only mean a third hash algorithm was added without
 *  updating these maps. */
function patternFor(patterns: ReadonlyMap<number, RegExp>, hexLength: number): RegExp {
  const pattern = patterns.get(hexLength);
  if (pattern === undefined) {
    throw new Error(`resolve-oid-prefix: no pattern registered for hexLength ${hexLength}`);
  }
  return pattern;
}

/** Max candidate oids embedded in an `AMBIGUOUS_OID_PREFIX` error payload. */
export const MAX_OID_PREFIX_CANDIDATES = 16;

/** Loose objects whose `<dir><name>` starts with `prefix` (name-based scan).
 *  No `exists` pre-probe: `readdir` itself answers "nothing loose here yet"
 *  via `isMissingFanoutDir` (a missing directory or a file occupying the
 *  fanout path), folded to an empty scan; any other fault (e.g. a
 *  `PERMISSION_DENIED` directory) is rethrown, never silently swallowed. */
const scanLoose = async (ctx: Context, prefix: string): Promise<ReadonlyArray<ObjectId>> => {
  const dir = objectsDir(commonGitDir(ctx), prefix.slice(0, 2));
  const rest = prefix.slice(2);
  const looseName = patternFor(LOOSE_NAME_PATTERNS, ctx.hashConfig.hexLength);
  let entries: Awaited<ReturnType<Context['fs']['readdir']>>;
  try {
    entries = await ctx.fs.readdir(dir);
  } catch (error) {
    if (!isMissingFanoutDir(error)) throw error;
    return [];
  }
  const found: ObjectId[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!looseName.test(entry.name)) continue;
    if (!entry.name.startsWith(rest)) continue;
    found.push((prefix.slice(0, 2) + entry.name) as ObjectId);
  }
  return found;
};

/** Packed objects whose id starts with `prefix`, across every registered pack. */
const scanPacks = async (ctx: Context, prefix: string): Promise<ReadonlyArray<ObjectId>> => {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  const packs = await registry.all();
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
  if (!patternFor(OID_PREFIX_PATTERNS, ctx.hashConfig.hexLength).test(prefix)) return undefined;
  const [loose, packed] = await Promise.all([scanLoose(ctx, prefix), scanPacks(ctx, prefix)]);
  const unique = [...new Set<ObjectId>([...loose, ...packed])];
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  throw ambiguousOidPrefix(prefix, unique.slice(0, MAX_OID_PREFIX_CANDIDATES));
};

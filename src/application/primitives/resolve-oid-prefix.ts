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
import type { CandidateReadFault } from '../../domain/objects/ambiguous-candidate.js';
import type { HashConfig } from '../../domain/objects/hash-config.js';
import { isOid, type ObjectId } from '../../domain/objects/index.js';
import { findByPrefix } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import {
  type CandidateFilter,
  describeCandidates,
  logCandidateReadFault,
  passesHint,
} from './internal/ambiguous-candidates.js';
import { configuredHint } from './internal/disambiguation-hints.js';
import { isMissingFanoutDir } from './internal/loose-oid-cache.js';
import { getObjectStore, type ObjectSource } from './object-store.js';
import { fanoutDirIn } from './path-layout.js';

/** Lower bound of an abbreviated-oid prefix — independent of the repository's
 *  hash width (measured against real git: a 4-char prefix resolves under
 *  both SHA-1 and SHA-256). */
const MIN_OID_PREFIX_LENGTH = 4;

/** The two hash widths a repository's `HashConfig.hexLength` ever reports. */
const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;

type HashAlgorithm = HashConfig['algorithm'];

/** A prefix pattern spanning `[MIN_OID_PREFIX_LENGTH, hexLength - 1]` hex
 *  chars — anything matching the full `hexLength` width is a full oid,
 *  handled by the `isOid` fast path below, never routed here. Built once per
 *  hash algorithm at module load — keyed by `HashConfig['algorithm']`, a
 *  closed union, so the lookup below is total and needs no runtime guard. */
const OID_PREFIX_PATTERNS: Readonly<Record<HashAlgorithm, RegExp>> = {
  sha1: new RegExp(`^[0-9a-f]{${MIN_OID_PREFIX_LENGTH},${SHA1_HEX_LENGTH - 1}}$`),
  sha256: new RegExp(`^[0-9a-f]{${MIN_OID_PREFIX_LENGTH},${SHA256_HEX_LENGTH - 1}}$`),
};

/** Loose object filename width: the fanout directory takes the first 2 hex
 *  chars, so the on-disk filename holds the remaining `hexLength - 2`. Built
 *  once per hash algorithm at module load, keyed the same way. */
const LOOSE_NAME_PATTERNS: Readonly<Record<HashAlgorithm, RegExp>> = {
  sha1: new RegExp(`^[0-9a-f]{${SHA1_HEX_LENGTH - 2}}$`),
  sha256: new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH - 2}}$`),
};

/** Looks up this repository's pattern by its own hash algorithm — a total
 *  map over `HashConfig['algorithm']`, so every repository resolves a
 *  pattern with no runtime fallback (and no throw) needed. */
function patternFor(
  patterns: Readonly<Record<HashAlgorithm, RegExp>>,
  algorithm: HashAlgorithm,
): RegExp {
  return patterns[algorithm];
}

/** Loose objects whose `<dir><name>` starts with `prefix` (name-based scan),
 *  in id order as git's loose-object cache walks them, whatever order
 *  `readdir` answers in.
 *  No `exists` pre-probe: `readdir` itself answers "nothing loose here yet"
 *  via `isMissingFanoutDir` (a missing directory or a file occupying the
 *  fanout path), folded to an empty scan; any other fault (e.g. a
 *  `PERMISSION_DENIED` directory) is rethrown, never silently swallowed. */
export const scanLooseIn = async (
  ctx: Context,
  source: ObjectSource,
  prefix: string,
): Promise<ReadonlyArray<ObjectId>> => {
  const dir = fanoutDirIn(source.objectsDir, prefix.slice(0, 2));
  const rest = prefix.slice(2);
  const looseName = patternFor(LOOSE_NAME_PATTERNS, ctx.hashConfig.algorithm);
  let entries: Awaited<ReturnType<Context['fs']['readdir']>>;
  try {
    entries = await source.fs.readdir(dir);
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
  return found.sort();
};

/** Packed objects whose id starts with `prefix`, across every pack registered in `source`. */
export const scanPacksIn = async (
  source: ObjectSource,
  prefix: string,
): Promise<ReadonlyArray<ObjectId>> => {
  const packs = await source.registry.all();
  const found: ObjectId[] = [];
  for (const pack of packs) {
    const index = await pack.index();
    for (const id of findByPrefix(index, prefix)) found.push(id);
  }
  return found;
};

export type { CandidateFilter };

/**
 * `update_disambiguate_state`'s hint reads: each candidate once, in scan
 * order, stopping at the second to pass — git needs no more to call the
 * prefix ambiguous. A failed read is reported as it happens.
 */
const leadingPassers = async (
  ctx: Context,
  candidates: ReadonlyArray<ObjectId>,
  accepts: CandidateFilter,
): Promise<ReadonlyArray<ObjectId>> => {
  const report = (fault: CandidateReadFault): void => logCandidateReadFault(ctx, fault);
  const passers: ObjectId[] = [];
  for (const id of candidates) {
    if (passers.length === 2) break;
    if (await passesHint(id, accepts, report)) passers.push(id);
  }
  return passers;
};

/**
 * `finish_object_disambiguation` then `get_short_oid`'s listing: the single
 * candidate passing `accepts` — or, when the caller names no hint,
 * `core.disambiguate`'s — wins; otherwise the prefix is ambiguous, the
 * listing still hinted when two passed it, else showing every match.
 */
const chooseCandidate = async (
  ctx: Context,
  prefix: string,
  candidates: ReadonlyArray<ObjectId>,
  accepts: CandidateFilter | undefined,
): Promise<ObjectId> => {
  const hint = accepts ?? (await configuredHint(ctx));
  const [chosen, rival] = hint === undefined ? [] : await leadingPassers(ctx, candidates, hint);
  if (chosen !== undefined && rival === undefined) return chosen;
  const listingHint = rival === undefined ? undefined : hint;
  const { candidates: described, readFaults } = await describeCandidates(
    ctx,
    candidates,
    listingHint,
  );
  throw ambiguousOidPrefix(prefix, described, readFaults);
};

export const resolveOidPrefix = async (
  ctx: Context,
  prefix: string,
  accepts?: CandidateFilter,
): Promise<ObjectId | undefined> => {
  if (isOid(prefix, ctx.hashConfig)) return prefix as ObjectId;
  if (!patternFor(OID_PREFIX_PATTERNS, ctx.hashConfig.algorithm).test(prefix)) return undefined;
  const { sources } = await getObjectStore(ctx);
  const perSource = await Promise.all(
    sources.map((source) =>
      Promise.all([scanLooseIn(ctx, source, prefix), scanPacksIn(source, prefix)]),
    ),
  );
  const unique = [...new Set<ObjectId>(perSource.flat(2))];
  if (unique.length <= 1) return unique[0];
  return chooseCandidate(ctx, prefix, unique, accepts);
};

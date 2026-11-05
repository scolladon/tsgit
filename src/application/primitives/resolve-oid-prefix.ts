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
import { errorDataCode } from '../../domain/error-data-code.js';
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

const UNABLE_TO_OPEN = 'unable to open';

/** git reports a directory it failed to list once per process: its loose-object cache
 *  keeps the failure and answers later scans from it. Keyed on `ctx.session`, as
 *  `loose-oid-cache`'s `fanoutCache`, so spread contexts share it. */
const failedListings = new WeakMap<Context['session'], Set<string>>();

const failedListingsOf = (ctx: Context): Set<string> => {
  let failed = failedListings.get(ctx.session);
  if (failed === undefined) {
    failed = new Set();
    failedListings.set(ctx.session, failed);
  }
  return failed;
};

/** git's `for_each_file_in_obj_subdir`: a fanout directory that cannot be listed is
 *  skipped and reported, never fatal. A missing directory ("nothing loose here yet")
 *  is silent. A failure carrying no code is not a filesystem answer: it propagates. */
const skipUnreadableFanout = (ctx: Context, dir: string, error: unknown): [] => {
  const code = errorDataCode(error);
  if (code === undefined) throw error;
  if (code === 'FILE_NOT_FOUND') return [];
  failedListingsOf(ctx).add(dir);
  ctx.logger?.error?.(`${UNABLE_TO_OPEN} ${dir}`, { path: dir, code });
  return [];
};

/** Loose objects whose `<dir><name>` starts with `prefix` (name-based scan),
 *  in id order as git's loose-object cache walks them, whatever order
 *  `readdir` answers in.
 *  No `exists` pre-probe: `readdir` itself answers "nothing loose here yet". A
 *  directory that cannot be listed (`PERMISSION_DENIED`, a file at the fanout path)
 *  folds to an empty scan and is logged once per session, as git does. */
export const scanLooseIn = async (
  ctx: Context,
  source: ObjectSource,
  prefix: string,
): Promise<ReadonlyArray<ObjectId>> => {
  const dir = fanoutDirIn(source.objectsDir, prefix.slice(0, 2));
  if (failedListingsOf(ctx).has(dir)) return [];
  const rest = prefix.slice(2);
  const looseName = patternFor(LOOSE_NAME_PATTERNS, ctx.hashConfig.algorithm);
  let entries: Awaited<ReturnType<Context['fs']['readdir']>>;
  try {
    entries = await source.fs.readdir(dir);
  } catch (error) {
    return skipUnreadableFanout(ctx, dir, error);
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

const scanSources = async (
  ctx: Context,
  sources: ReadonlyArray<ObjectSource>,
  prefix: string,
): Promise<ReadonlyArray<ObjectId>> => {
  const perSource = await Promise.all(
    sources.map((source) =>
      Promise.all([scanLooseIn(ctx, source, prefix), scanPacksIn(source, prefix)]),
    ),
  );
  return [...new Set<ObjectId>(perSource.flat(2))];
};

/** The fanout directory a prefix scan consults in each object source. */
const consultedDirectories = (
  sources: ReadonlyArray<ObjectSource>,
  prefix: string,
): ReadonlyArray<string> =>
  sources.map((source) => fanoutDirIn(source.objectsDir, prefix.slice(0, 2)));

/** Whether a miss consulted a directory whose listing failed earlier in the session. */
const consultedFailure = (ctx: Context, directories: ReadonlyArray<string>): boolean => {
  const failed = failedListingsOf(ctx);
  return directories.some((directory) => failed.has(directory));
};

/** git's `get_short_oid` scans a miss again after `reprepare_packed_git`, which drops the
 *  loose-object cache: only the directories this miss consulted are forgotten before the
 *  second scan. */
const forgetAndRescan = async (
  ctx: Context,
  sources: ReadonlyArray<ObjectSource>,
  directories: ReadonlyArray<string>,
  prefix: string,
): Promise<ReadonlyArray<ObjectId>> => {
  const failed = failedListingsOf(ctx);
  for (const directory of directories) failed.delete(directory);
  return scanSources(ctx, sources, prefix);
};

export const resolveOidPrefix = async (
  ctx: Context,
  prefix: string,
  accepts?: CandidateFilter,
): Promise<ObjectId | undefined> => {
  if (isOid(prefix, ctx.hashConfig)) return prefix as ObjectId;
  if (!patternFor(OID_PREFIX_PATTERNS, ctx.hashConfig.algorithm).test(prefix)) return undefined;
  const { sources } = await getObjectStore(ctx);
  const first = await scanSources(ctx, sources, prefix);
  const directories = consultedDirectories(sources, prefix);
  // Only a remembered failure makes git's reprepare rescan worth running.
  const unique =
    first.length === 0 && consultedFailure(ctx, directories)
      ? await forgetAndRescan(ctx, sources, directories, prefix)
      : first;
  if (unique.length <= 1) return unique[0];
  return chooseCandidate(ctx, prefix, unique, accepts);
};

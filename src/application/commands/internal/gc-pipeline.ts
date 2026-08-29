/**
 * `gc` task mechanics for the `maintenance` command — extracted from
 * `maintenance.ts` to keep that file's role scoped to the command shell
 * (option validation, task ordering, result assembly). Owns the reachable/
 * unreachable partition, the normal/promisor/cruft pack builds, reuse
 * detection, and superseded-pack retirement. See `maintenance.ts`'s module
 * doc for the task's observable contract.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import { type PackIndexWriterEntry, parseMultiPackIndex } from '../../../domain/storage/index.js';
import { allObjectIds } from '../../../domain/storage/pack-index.js';
import type { Context } from '../../../ports/context.js';
import type { DirEntry, FileStat } from '../../../ports/file-system.js';
import { buildPack } from '../../primitives/build-pack.js';
import { assertValidGcAutoConfig, readConfig } from '../../primitives/config-read.js';
import { enumerateObjects } from '../../primitives/enumerate-objects.js';
import { expiryCutoff } from '../../primitives/expiry-cutoff.js';
import { assertValidBooleanConfig } from '../../primitives/internal/boolean-config-guard.js';
import { type ClosureTier, computeClosure } from '../../primitives/internal/closure-engine.js';
import { boundedMapFor } from '../../primitives/internal/concurrency.js';
import {
  computeCruftMtimes,
  decideCruftFate,
  declassifyCruftPack,
  type ExistingCruftPack,
  readExistingCruftPack,
  retireCruftPack,
  writeCruftPack,
} from '../../primitives/internal/cruft-pack-lifecycle.js';
import { errorDataCode } from '../../primitives/internal/error-data-code.js';
import { forgetLooseOidPrefix } from '../../primitives/internal/loose-oid-cache.js';
import { forgetParsedObjectMemo } from '../../primitives/internal/object-caches.js';
import {
  packFilePath,
  writePackArtifactsViaQuarantine,
} from '../../primitives/internal/write-pack-artifacts.js';
import {
  classifyPackFiles,
  type PackRegistry,
  type RegisteredPack,
} from '../../primitives/pack-registry.js';
import {
  commonGitDir,
  looseObjectPath,
  multiPackIndexPath,
  packsDir,
} from '../../primitives/path-layout.js';
import { getPackRegistry, readObject, refreshPackRegistry } from '../../primitives/read-object.js';
import { writeObject } from '../../primitives/write-object.js';
import type { MaintenanceResult } from '../maintenance.js';
import { collectRetentionRoots } from './fsck/roots.js';

const DEFAULT_GC_AUTO_THRESHOLD = 6700;
const DEFAULT_PRUNE_EXPIRE = '2.weeks.ago';
const CLOSURE_TIER: ClosureTier = 'walk';

export type GcResult = Omit<
  MaintenanceResult,
  'tasksRun' | 'commitGraphWritten' | 'commitsInGraph'
>;

export const GC_NOT_RUN: GcResult = {
  looseObjectsBefore: 0,
  looseObjectsPacked: 0,
  prunedLooseObjects: 0,
  packsBefore: 0,
  packsAfter: 0,
  packId: undefined,
  cruftObjectsAdded: 0,
  cruftObjectsRetained: 0,
  cruftObjectsExpired: 0,
  cruftPackId: undefined,
  promisorPackId: undefined,
  packsRetired: 0,
  packBytesBefore: 0,
  packBytesAfter: 0,
};

/**
 * `auto: true` consults `gc.auto` (git default 6700; `0` disables the
 * automatic gc entirely — pinned against git 2.55.0: `gc.auto=0` plus
 * `git gc --auto` runs nothing, at any loose count). `auto` absent/false
 * always runs, mirroring explicit `git gc` ignoring `gc.auto` entirely.
 */
async function shouldDeclineForAuto(
  ctx: Context,
  auto: boolean | undefined,
  looseCount: number,
): Promise<boolean> {
  if (auto !== true) return false;
  await assertValidGcAutoConfig(ctx);
  const threshold = (await readConfig(ctx)).gc?.auto ?? DEFAULT_GC_AUTO_THRESHOLD;
  if (threshold === 0) return true;
  return looseCount <= threshold;
}

const TEMP_FILE_PREFIX = 'tmp_';
/** A fanout dir's own quarantine naming is narrower than root/pack's — git's
 *  fanout walk only ever writes (and only ever recognises) this prefix; a
 *  hand-placed `tmp_`-prefixed name that isn't also `tmp_obj_`-prefixed is
 *  not gc's litter to remove there, even though the broader `tmp_` prefix
 *  is in scope at the root and in `objects/pack/`. */
const FANOUT_TEMP_FILE_PREFIX = 'tmp_obj_';

/** Every two-hex-digit fanout name (`00`..`ff`) git's on-disk layout
 *  reserves, enumerated BY CONSTRUCTION rather than discovered from the
 *  `objects/` root's own listing — the same universe `enumerate-objects.ts`
 *  walks for loose objects. A fanout dir's litter must still be scanned
 *  when the root listing itself fails (`EACCES` there is tolerated, not
 *  fatal — see `removeStaleTempFiles`); deriving the fanout set from that
 *  listing would silently skip every fanout dir on exactly the run that
 *  most needs the fallback. */
const FANOUT_NAMES: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

/** git's own quarantine naming for an in-progress loose-object, pack or
 *  cruft-artefact write — the same naming `isLooseObjectSuffix`
 *  (`enumerate-objects.ts`) filters OUT of the loose-object universe.
 *  Directories never qualify: only a stray FILE is litter. */
function isTempFileEntry(entry: DirEntry, prefix: string): boolean {
  return entry.isFile && entry.name.startsWith(prefix);
}

/** `readdir` that tolerates ANY fault — a missing dir, `EACCES`, or
 *  anything else simply yields no entries. Mirrors git's own
 *  `remove_temporary_files`, which warns to stderr and moves on rather than
 *  aborting; tsgit has no warning channel, so the location is silently
 *  skipped instead. Used for `objects/` root and `objects/pack/` only — a
 *  fanout dir's own `opendir` keeps the stricter, ENOENT-only tolerance
 *  below (the one place git's own strictness actually lives). */
async function readdirTolerant(ctx: Context, dir: string): Promise<ReadonlyArray<DirEntry>> {
  try {
    return await ctx.fs.readdir(dir);
  } catch {
    return [];
  }
}

/** `prefix`-matching file paths sitting directly inside `dir`, via the
 *  fault-tolerant `readdirTolerant` above — the root/pack scan scope. */
async function listTempFileCandidatesTolerant(
  ctx: Context,
  dir: string,
  prefix: string,
): Promise<ReadonlyArray<string>> {
  const entries = await readdirTolerant(ctx, dir);
  return entries
    .filter((entry) => isTempFileEntry(entry, prefix))
    .map((entry) => `${dir}/${entry.name}`);
}

/** Whether `dir`'s own `readdir` fault means "nothing to enumerate here" —
 *  tolerated the same way git's fanout walk tolerates ENOENT. A real
 *  filesystem (node, browser) reports a missing directory as
 *  `FILE_NOT_FOUND` directly (its `ENOENT` maps there, distinct from
 *  `ENOTDIR`). tsgit's `readdir` port contract, though, only documents
 *  `NOT_A_DIRECTORY`, and the in-memory adapter has no separate "doesn't
 *  exist" outcome for `readdir` at all — it reports both "missing" and "a
 *  plain file sits here instead of a directory" as `NOT_A_DIRECTORY`. A
 *  `NOT_A_DIRECTORY` fault therefore falls back to `exists(dir)` to tell the
 *  two apart: absent still tolerates (matches git's ENOENT tolerance); a
 *  real file blocking the fanout name rethrows, exactly as git's `opendir`
 *  hard-failing on a genuine ENOTDIR would. The fallback only ever runs on
 *  that one fault, so the common 254-miss path (every real adapter's
 *  `FILE_NOT_FOUND`) costs nothing extra. */
async function isFanoutDirAbsent(ctx: Context, dir: string, error: unknown): Promise<boolean> {
  const code = errorDataCode(error);
  if (code === 'FILE_NOT_FOUND') return true;
  if (code !== 'NOT_A_DIRECTORY') return false;
  return !(await ctx.fs.exists(dir));
}

/** `prefix`-matching file paths sitting directly inside a FANOUT `dir` —
 *  tolerant only of `dir` itself being absent (254 of the 256
 *  by-construction names typically are — an as-yet-unused fanout prefix —
 *  or one that vanished mid-scan); every other opendir/readdir fault
 *  rethrows, mirroring git's fanout walk hard-failing on anything but
 *  ENOENT — the one location git itself is strict. */
async function listTempFileCandidatesStrict(
  ctx: Context,
  dir: string,
  prefix: string,
): Promise<ReadonlyArray<string>> {
  let entries: ReadonlyArray<DirEntry>;
  try {
    entries = await ctx.fs.readdir(dir);
  } catch (error) {
    if (!(await isFanoutDirAbsent(ctx, dir, error))) throw error;
    return [];
  }
  return entries
    .filter((entry) => isTempFileEntry(entry, prefix))
    .map((entry) => `${dir}/${entry.name}`);
}

/** Idempotent, fault-swallowing single-file removal — unlike `rmTolerant`,
 *  ANY failure (not just a missing file) is absorbed here, since git's own
 *  per-file removal (`prune_tmp_file`) warns and continues rather than
 *  aborting, uniformly at every location it runs. */
async function rmSilently(ctx: Context, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch {
    // intentionally swallowed — see doc above.
  }
}

/** Removes `path` when its own mtime is at or before `cutoff` — the same
 *  `mtime > cutoff` survival rule `partitionByCutoff` applies to cruft
 *  candidates. git's strictness never lives in the per-file handler: the
 *  same `prune_tmp_file` runs at root, fanout and pack alike, and absorbs
 *  ANY lstat/rm fault — vanished, `EACCES`, … — everywhere it runs. The
 *  only strict gate in this whole scan is a fanout dir's own `opendir`
 *  (`listTempFileCandidatesStrict`); a path reaching here has already
 *  passed it. */
async function removeIfStaleTempFile(ctx: Context, path: string, cutoff: number): Promise<void> {
  let stat: FileStat;
  try {
    stat = await ctx.fs.lstat(path);
  } catch {
    return;
  }
  const mtimeSeconds = Math.floor(stat.mtimeMs / 1000);
  if (mtimeSeconds > cutoff) return;
  await rmSilently(ctx, path);
}

/**
 * Deletes stale quarantine litter from every location git itself writes it
 * to — `objects/` root, every fanout dir, and `objects/pack/` — once this
 * run has actually proceeded past the `gc.auto` gate (a decline performs no
 * cleanup of any kind, litter included). git's OWN strictness lives at
 * exactly one point: a fanout dir's `opendir` hard-fails on anything but
 * ENOENT (`listTempFileCandidatesStrict`); everywhere else — root/pack
 * `readdir`, and the per-file lstat/rm at every one of the three locations
 * (`removeIfStaleTempFile`) — every fault is absorbed and the scan moves on
 * (no warning channel to mirror git's stderr). Fanout dirs are enumerated
 * BY CONSTRUCTION (`FANOUT_NAMES`, `00`..`ff`) rather than discovered from
 * the root's own listing, so an `EACCES` reading `objects/` skips only the
 * root's OWN `tmp_` candidates, never the fanout scan.
 *
 * Called from `runGcTask` after every pack write, verify, prune and
 * retirement step this run performs — the same position git's own
 * `remove_temporary_files` occupies, at the tail of the `prune` step,
 * strictly after `repack` has finished consolidating and retiring packs.
 * A run that never reaches that point (an aborted pack write, a repack
 * failure) leaves existing litter untouched, exactly as a failed `git gc`
 * does. This run's OWN quarantine writes are already complete by the time
 * the scan starts, so it can never race them into existence; the age gate
 * is the sole remaining protection against a DIFFERENT, concurrently
 * running process's own in-flight quarantine write — a fresh mtime keeps
 * it on the "survivor" side of the cutoff. That protection does not hold
 * at `gc.pruneExpire=now` (or `all`): those resolve to the maximum time,
 * so the age gate is fully disabled and every candidate — a concurrent
 * process's in-flight quarantine write included — falls on the doomed
 * side, exactly git's own `--expire=now` behaviour (measured: git prunes
 * a future-mtime temp file under it). `cutoff` is the identical `gc.pruneExpire`-
 * derived value the cruft-pack survival rule uses: `never` resolves to
 * `-Infinity`, under which every candidate would survive the age gate
 * anyway, so the scan itself is skipped rather than run for nothing.
 */
async function removeStaleTempFiles(ctx: Context, packDir: string, cutoff: number): Promise<void> {
  if (cutoff === Number.NEGATIVE_INFINITY) return;

  const objectsRoot = `${commonGitDir(ctx)}/objects`;
  const rootCandidates = await listTempFileCandidatesTolerant(ctx, objectsRoot, TEMP_FILE_PREFIX);
  const packCandidates = await listTempFileCandidatesTolerant(ctx, packDir, TEMP_FILE_PREFIX);
  const fanoutDirs = FANOUT_NAMES.map((name) => `${objectsRoot}/${name}`);
  const fanoutCandidateLists = await boundedMapFor(ctx, 'ioBound', fanoutDirs, (dir) =>
    listTempFileCandidatesStrict(ctx, dir, FANOUT_TEMP_FILE_PREFIX),
  );

  const candidates = [...rootCandidates, ...packCandidates, ...fanoutCandidateLists.flat()];
  await boundedMapFor(ctx, 'ioBound', candidates, (path) =>
    removeIfStaleTempFile(ctx, path, cutoff),
  );
}

async function computeReachableSet(ctx: Context): Promise<ReadonlySet<ObjectId>> {
  const roots = await collectRetentionRoots(ctx);
  const closure = await computeClosure(ctx, {
    wants: [...roots],
    not: [],
    objects: true,
    tier: CLOSURE_TIER,
  });
  return new Set(closure.objects.map((object) => object.id));
}

/**
 * Step 1b: `lstat` every registered pack ONCE, before anything is written —
 * `mtimeMs` is the only source for an object migrating out of a superseded
 * NORMAL pack (Pin Y), and `size` on the same result is the free half of
 * `packBytesBefore`/`packBytesAfter` (R33).
 */
async function lstatPacks(
  ctx: Context,
  packs: ReadonlyArray<RegisteredPack>,
): Promise<ReadonlyMap<string, FileStat>> {
  const pairs = await boundedMapFor(ctx, 'ioBound', packs, async (pack) => {
    const stat = await ctx.fs.lstat(pack.packPath);
    return [pack.name, stat] as const;
  });
  return new Map(pairs);
}

function sumPackBytes(stats: ReadonlyArray<FileStat>): number {
  return stats.reduce((total, stat) => total + stat.size, 0);
}

async function unionOids(packs: ReadonlyArray<RegisteredPack>): Promise<ReadonlySet<ObjectId>> {
  const oids = new Set<ObjectId>();
  for (const pack of packs) {
    for (const id of allObjectIds(await pack.index())) oids.add(id);
  }
  return oids;
}

interface NormalPackData {
  readonly oids: ReadonlySet<ObjectId>;
  /** oid → the CONTAINING normal pack's own `lstat` mtime (seconds) — the
   *  third mtime source (Pins Q, Y). An oid present in more than one normal
   *  pack takes the newest of them, the same `max`-never-fallback rule. */
  readonly mtimeOf: ReadonlyMap<ObjectId, number>;
}

/** Widens the candidate universe with every NORMAL pack's own oid list and
 *  the mtime an object migrating out of it must carry (step 4). */
async function collectNormalPackData(
  normalPacks: ReadonlyArray<RegisteredPack>,
  statByName: ReadonlyMap<string, FileStat>,
): Promise<NormalPackData> {
  const oids = new Set<ObjectId>();
  const mtimeOf = new Map<ObjectId, number>();
  for (const pack of normalPacks) {
    const stat = statByName.get(pack.name) as FileStat;
    const mtimeSeconds = Math.floor(stat.mtimeMs / 1000);
    for (const id of allObjectIds(await pack.index())) {
      oids.add(id);
      const prior = mtimeOf.get(id);
      mtimeOf.set(id, prior === undefined ? mtimeSeconds : Math.max(prior, mtimeSeconds));
    }
  }
  return { oids, mtimeOf };
}

/**
 * Step 4's widened partition: `owned` gains every NORMAL pack's oids
 * (consolidation's whole contribution); `keptOids` is subtracted from BOTH
 * output sets — Pin V's total exclusion, an oid inside a kept pack is never
 * repacked and never crufted, even when it is ALSO loose or in a normal
 * pack.
 *
 * `ownedPromisor` is a DIFFERENT kind of overlap. Pinned against git 2.55.0
 * (mktemp probe, `.promisor`-marked pack containing already-packed reachable
 * content, a further reachable commit added, `git gc` run): a REACHABLE
 * promisor-pack object is packed into BOTH the rebuilt promisor pack AND the
 * ordinary "all reachable" pack — git does not treat promisor membership as
 * an exclusion from the normal pack the way it treats `.keep`. So a
 * reachable promisor oid is pushed into `toNormalPack` here (whether it
 * reaches this function via `owned`'s loose/normal-pack route, or via
 * `ownedPromisor` alone for an object that lives ONLY in a promisor pack —
 * the second loop below, since `owned` never gains a promisor pack's own
 * oids). An UNREACHABLE promisor oid is the one case `ownedPromisor` still
 * excludes: it must never reach `cruftCandidates`, because a cruft pack
 * cannot carry the `.promisor` marker and moving it there would announce a
 * lazily-fetchable object as fully present locally — the same correctness
 * break merging the two packs would be. `toPromisorPack` (computed
 * separately) is unconditionally the WHOLE promisor set regardless of
 * reachability, so a reachable promisor oid is the one class this partition
 * deliberately does NOT keep disjoint across its outputs — `toNormalPack`
 * and `toPromisorPack` intersect exactly on it, by design.
 */
function partitionOwned(
  owned: ReadonlySet<ObjectId>,
  reachable: ReadonlySet<ObjectId>,
  keptOids: ReadonlySet<ObjectId>,
  ownedPromisor: ReadonlySet<ObjectId>,
): {
  readonly toNormalPack: ReadonlyArray<ObjectId>;
  readonly cruftCandidates: ReadonlyArray<ObjectId>;
} {
  const toNormalPack: ObjectId[] = [];
  const cruftCandidates: ObjectId[] = [];
  for (const id of owned) {
    if (keptOids.has(id)) continue;
    if (ownedPromisor.has(id)) {
      // Overlap: also loose or in a normal pack. Reachable duplicates into
      // the normal pack too (git does); unreachable stays out of cruft —
      // the promisor pack is its only home either way.
      if (reachable.has(id)) toNormalPack.push(id);
      continue;
    }
    (reachable.has(id) ? toNormalPack : cruftCandidates).push(id);
  }
  // A reachable object living ONLY in a promisor pack (never loose, never
  // in a normal pack) never visits the loop above — `owned` carries no
  // promisor-pack oids of its own. `!owned.has(id)` is what stops this from
  // double-pushing an id the loop already handled via the overlap branch.
  for (const id of ownedPromisor) {
    if (!keptOids.has(id) && reachable.has(id) && !owned.has(id)) toNormalPack.push(id);
  }
  // `buildPack` writes entries in ARRAY order and does not sort them itself
  // (only the `.idx`/`.rev` writers do) — so an oid duplicating in via the
  // second loop above lands at the END on the run that first discovers it,
  // but at its sorted position on every LATER run once it is also a member
  // of `owned` (via the normal pack `collectNormalPackData` just read,
  // itself oid-sorted). Left unsorted, that shift alone would change the
  // normal pack's sha on the very next run, breaking Pin W's no-op
  // boundary for no reason a caller could observe as a real content change.
  toNormalPack.sort();
  return { toNormalPack, cruftCandidates };
}

/**
 * `computeCruftMtimes` guarantees every cruft candidate has at least one
 * mtime source by construction (loose lstat, carried sidecar entry, or a
 * superseded normal pack's own lstat) — a miss here means that invariant
 * broke elsewhere. Fail loud rather than silently: `undefined > cutoff` is
 * `false`, so a swallowed miss would route straight into `doomed` and
 * destroy an object gc never actually aged.
 */
function mtimeOrThrow(mtimes: ReadonlyMap<ObjectId, number>, id: ObjectId): number {
  const mtime = mtimes.get(id);
  if (mtime === undefined) {
    throw new Error(`gc invariant violated: no mtime recorded for cruft candidate ${id}`);
  }
  return mtime;
}

function partitionByCutoff(
  candidates: ReadonlyArray<ObjectId>,
  mtimes: ReadonlyMap<ObjectId, number>,
  cutoff: number,
): { readonly survivors: ReadonlyArray<ObjectId>; readonly doomed: ReadonlyArray<ObjectId> } {
  const survivors: ObjectId[] = [];
  const doomed: ObjectId[] = [];
  for (const id of candidates) {
    const mtime = mtimeOrThrow(mtimes, id);
    (mtime > cutoff ? survivors : doomed).push(id);
  }
  return { survivors, doomed };
}

function indexEntriesFor(
  oids: ReadonlyArray<ObjectId>,
  entries: ReadonlyArray<{ readonly crc32: number; readonly offset: number }>,
): ReadonlyArray<PackIndexWriterEntry> {
  return oids.map((id, i) => ({ id, crc32: entries[i]!.crc32, offset: entries[i]!.offset }));
}

interface NormalPackOutcome {
  readonly packId: ObjectId | undefined;
  /**
   * Which pre-existing pack, if any, this run's build reproduced
   * byte-for-byte (`buildPack` is deterministic — same oid set, same
   * bytes): `'cruft'` when the sha matches an EXISTING cruft pack (a
   * resurrected cruft set moving intact into the normal pack — that pack
   * must be DECLASSIFIED, its `.mtimes` dropped, never retired as garbage);
   * `'normal'` when it matches an existing normal pack (Pin W's no-op
   * boundary — that exact pack must NOT appear in the retirement list,
   * since it now IS the fresh normal pack); `'none'` otherwise.
   */
  readonly reuse: 'none' | 'cruft' | 'normal';
}

/**
 * Skipped entirely (`packId: undefined`) when `oids` is empty — git writes
 * no pack rather than a zero-object one (Pin V). Otherwise ALWAYS writes
 * fresh, via `writePackArtifactsViaQuarantine`: Pin W shows git rewrites
 * even an unchanged single pack on every run (a skipped rewrite would leave
 * the pack's mtime stale, silently ageing objects that later migrate out of
 * it — Pin Y), so there is no "already consolidated ⇒ skip" branch here.
 */
async function buildAndWriteNormalPack(
  ctx: Context,
  packDir: string,
  oids: ReadonlyArray<ObjectId>,
  existingCruftShas: ReadonlySet<string>,
  existingNormalNames: ReadonlySet<string>,
): Promise<NormalPackOutcome> {
  if (oids.length === 0) return { packId: undefined, reuse: 'none' };
  const pack = await buildPack(ctx, { oids });
  const written = await writePackArtifactsViaQuarantine(ctx, {
    packDir,
    packBytes: pack.bytes,
    entries: indexEntriesFor(oids, pack.entries),
    packSha: pack.sha,
    promisor: false,
  });
  const reuse = existingCruftShas.has(pack.sha)
    ? 'cruft'
    : existingNormalNames.has(`pack-${pack.sha}`)
      ? 'normal'
      : 'none';
  return { packId: written.packSha as ObjectId, reuse };
}

interface PromisorPackOutcome {
  readonly packId: ObjectId | undefined;
  /** Set when this run's build reproduced an EXISTING promisor pack's name
   *  byte-for-byte (the promisor set is unchanged since the last run) — that
   *  pack must NOT appear in the retirement list, since it now IS the fresh
   *  promisor pack. */
  readonly reusedExistingName: string | undefined;
}

/**
 * Step 6b: builds and writes the promisor pack from `toPromisorPack` — the
 * WHOLE union of every promisor pack's own oids, reachability irrelevant.
 * Skipped entirely (`packId: undefined`) when `oids` is empty — every
 * repository that is not a partial clone. Otherwise ALWAYS writes fresh, via
 * `writePackArtifactsViaQuarantine`, for the same no-skip reason step 6's
 * normal pack never short-circuits: a repeat run over an unchanged promisor
 * set reproduces the same sha (Pin W's boundary, one class over), and the
 * quarantine writer is what lets that same-name rewrite land without a
 * `FILE_EXISTS` refusal.
 */
async function buildAndWritePromisorPack(
  ctx: Context,
  packDir: string,
  oids: ReadonlyArray<ObjectId>,
  existingPromisorNames: ReadonlySet<string>,
): Promise<PromisorPackOutcome> {
  if (oids.length === 0) return { packId: undefined, reusedExistingName: undefined };
  const pack = await buildPack(ctx, { oids });
  const written = await writePackArtifactsViaQuarantine(ctx, {
    packDir,
    packBytes: pack.bytes,
    entries: indexEntriesFor(oids, pack.entries),
    packSha: pack.sha,
    promisor: true,
  });
  const writtenName = `pack-${written.packSha}`;
  return {
    packId: written.packSha as ObjectId,
    reusedExistingName: existingPromisorNames.has(writtenName) ? writtenName : undefined,
  };
}

/**
 * A `fate: 'rewrite'` build whose survivor set happens to reproduce an
 * EXISTING cruft pack's bytes byte-for-byte is real: the two-cruft-pack
 * crash-recovery state is always the newer one being a superset of the
 * older, so a follow-up run's union-derived survivor set routinely
 * reproduces the newer pack exactly. Unlike a normal pack (Pin Y), a cruft
 * pack's OWN file mtime carries no semantic weight — ages live in the
 * `.mtimes` sidecar, never the `stat` — so reusing the file in place is
 * safe and simpler than a quarantine rewrite: no `FILE_EXISTS` risk, no
 * mtime to refresh.
 */
async function buildAndWriteCruftPack(
  ctx: Context,
  packDir: string,
  survivors: ReadonlyArray<ObjectId>,
  mtimes: ReadonlyMap<ObjectId, number>,
  existingCruftShas: ReadonlySet<string>,
): Promise<ObjectId> {
  const pack = await buildPack(ctx, { oids: survivors });
  if (existingCruftShas.has(pack.sha)) return pack.sha as ObjectId;
  const written = await writeCruftPack(ctx, {
    packDir,
    entries: indexEntriesFor(survivors, pack.entries),
    packBytes: pack.bytes,
    packSha: pack.sha,
    mtimeOf: (id) => mtimeOrThrow(mtimes, id),
  });
  return written.packSha as ObjectId;
}

/** Writes a surviving-but-not-loose object (carried only in a pack about to
 *  be superseded) back out as an ordinary loose file — the
 *  `gc.cruftPacks=false` write-back path. A no-op when the object is
 *  already loose. */
async function loosenIfNotLoose(
  ctx: Context,
  id: ObjectId,
  looseSet: ReadonlySet<ObjectId>,
): Promise<void> {
  if (looseSet.has(id)) return;
  await writeObject(ctx, await readObject(ctx, id));
}

interface CruftOutcome {
  readonly cruftPackId: ObjectId | undefined;
}

/**
 * Physically executes the cruft pack's fate. `gc.cruftPacks=false` bypasses
 * the pack entirely: survivors are written back loose (when not already) —
 * this now also covers a survivor that only lived inside a superseded
 * NORMAL pack, since `survivors` is drawn from the widened `cruftCandidates`
 * (Pin AA).
 */
async function applyCruftOutcome(
  ctx: Context,
  packDir: string,
  cruftPacksEnabled: boolean,
  survivors: ReadonlyArray<ObjectId>,
  existingCruft: ExistingCruftPack,
  looseSet: ReadonlySet<ObjectId>,
  mtimes: ReadonlyMap<ObjectId, number>,
): Promise<CruftOutcome> {
  if (!cruftPacksEnabled) {
    await boundedMapFor(ctx, 'ioBound', survivors, (id) => loosenIfNotLoose(ctx, id, looseSet));
    return { cruftPackId: undefined };
  }

  const existingCruftKeys = new Set(existingCruft.mtimes.keys());
  const fate = decideCruftFate(survivors, existingCruftKeys, existingCruft.packShas.length);
  if (fate === 'noop') return { cruftPackId: existingCruft.packShas[0] as ObjectId };
  if (fate === 'delete') return { cruftPackId: undefined };
  const cruftPackId = await buildAndWriteCruftPack(
    ctx,
    packDir,
    survivors,
    mtimes,
    new Set(existingCruft.packShas),
  );
  return { cruftPackId };
}

function isFileNotFound(error: unknown): boolean {
  return errorDataCode(error) === 'FILE_NOT_FOUND';
}

/** Idempotent single-file removal: absent is success, everything else rethrows. */
async function rmTolerant(ctx: Context, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

/**
 * Retires a superseded NORMAL pack's four siblings (step 10b) — `.idx`
 * FIRST (removes it from every reader's candidate scan in one unlink, so
 * everything after operates on litter), then `.pack`/`.rev`/`.bitmap` —
 * there is no class-carrying sidecar to protect here, so the rest carries
 * no ordering constraint of its own. Pin X: a superseded pack's `.bitmap`
 * is deleted with it, never left orphaned.
 */
async function retireNormalPack(ctx: Context, packDir: string, packSha: string): Promise<void> {
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.idx`);
  await rmTolerant(ctx, packFilePath(packDir, packSha));
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.rev`);
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.bitmap`);
}

/**
 * Retires a superseded PROMISOR pack's siblings (step 10c) — `.idx` FIRST,
 * the same reader-visibility rule step 10b uses, then `.pack`/`.rev`/
 * `.bitmap`, and `.promisor` LAST of all: a pack findable without its marker
 * reads as an ordinary normal pack, and a later gc would merge its objects
 * into the normal pack — the one outcome consolidation may never produce —
 * so the marker must outlive the `.idx` that makes the pack findable at all.
 */
async function retirePromisorPack(ctx: Context, packDir: string, packSha: string): Promise<void> {
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.idx`);
  await rmTolerant(ctx, packFilePath(packDir, packSha));
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.rev`);
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.bitmap`);
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.promisor`);
}

/**
 * Steps 9b/10/10b/10c: retires every superseded pack this run decided on —
 * normal, cruft and promisor alike. Step 8's verify loop and step 9's
 * `packedAnywhere` both open FRESH read handles against the generation
 * `refreshPackRegistry` started at the top of step 8 — handles a bare
 * `settleRefresh()` would not drain, since it only awaits the close of
 * whatever generation the LAST `refresh()` already ended. `refresh()` here
 * ends THAT generation (the one verify/packedAnywhere just read through)
 * before `settleRefresh()` awaits its handles closing, so every unlink
 * below is guaranteed to run against fully-closed files (Windows-unlink
 * safety) rather than racing a still-open one.
 */
async function retireSupersededPacks(
  ctx: Context,
  registry: Pick<PackRegistry, 'refresh' | 'settleRefresh'>,
  packDir: string,
  normalPacksToRetire: ReadonlyArray<RegisteredPack>,
  cruftShasToRetire: ReadonlyArray<string>,
  promisorPacksToRetire: ReadonlyArray<RegisteredPack>,
): Promise<void> {
  if (
    normalPacksToRetire.length === 0 &&
    cruftShasToRetire.length === 0 &&
    promisorPacksToRetire.length === 0
  ) {
    return;
  }
  registry.refresh();
  await registry.settleRefresh();
  for (const pack of normalPacksToRetire) {
    await retireNormalPack(ctx, packDir, pack.name.slice('pack-'.length));
  }
  for (const sha of cruftShasToRetire) {
    await retireCruftPack(ctx, packDir, sha);
  }
  for (const pack of promisorPacksToRetire) {
    await retirePromisorPack(ctx, packDir, pack.name.slice('pack-'.length));
  }
}

/**
 * Deletes `objects/pack/multi-pack-index` whenever it names any pack this
 * run retired (Pin T; Pin G row 1) — the only available verb, since tsgit
 * has no midx writer. A midx naming only surviving (kept) packs is left
 * alone (Pin G row 2). A no-op, no read at all, when nothing was retired.
 */
async function expireMidxIfNeeded(
  ctx: Context,
  packDir: string,
  retiredIdxNames: ReadonlySet<string>,
): Promise<void> {
  if (retiredIdxNames.size === 0) return;
  const path = multiPackIndexPath(packDir);
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(path);
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw error;
  }
  const midx = parseMultiPackIndex(bytes, ctx.hashConfig.digestLength);
  if (midx.packNames.some((name) => retiredIdxNames.has(name))) {
    await rmTolerant(ctx, path);
  }
}

/** Loose oids that already resolve through the (just-refreshed) pack
 *  registry — reachable ones just packed, survivors just crufted, and any
 *  loose file that happened to duplicate a pre-existing pack's object
 *  ("prune-packable" in git's `count-objects -v` naming). Consolidation
 *  needs no change here: whatever this finds already surviving in a kept
 *  pack, the new normal pack, or the cruft pack is correct regardless of
 *  whether the packs it was ALSO duplicated in have been retired yet. */
async function packedAnywhere(
  ctx: Context,
  looseSet: ReadonlySet<ObjectId>,
): Promise<ReadonlySet<ObjectId>> {
  const registry = getPackRegistry(ctx);
  const looseArray = [...looseSet];
  const hits = await boundedMapFor(ctx, 'ioBound', looseArray, async (id) =>
    (await registry.lookup(id)) !== undefined ? id : undefined,
  );
  return new Set(hits.filter((id): id is ObjectId => id !== undefined));
}

async function pruneLooseFiles(ctx: Context, ids: ReadonlySet<ObjectId>): Promise<void> {
  const gitDir = commonGitDir(ctx);
  for (const id of ids) {
    try {
      await ctx.fs.rm(looseObjectPath(gitDir, id));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    forgetLooseOidPrefix(ctx, id);
  }
}

interface RunGcOptions {
  readonly auto: boolean | undefined;
}

export async function runGcTask(
  ctx: Context,
  opts: RunGcOptions,
): Promise<{ readonly ran: boolean; readonly result: GcResult }> {
  const packDir = packsDir(commonGitDir(ctx));

  // A long-lived Context can see `objects/pack/` mutated out of band between
  // two `maintenance()` calls (a caller marking a pack `.keep`, another
  // process writing a pack) — gc must never classify or consolidate against
  // a stale scan, so it starts every run with a forced re-scan.
  refreshPackRegistry(ctx);

  // --- step 1: loose count + the auto gate ---
  const looseIds = await enumerateObjects(ctx, { includePacks: false });
  const looseSet = new Set(looseIds);
  const looseObjectsBefore = looseIds.length;

  const registry = getPackRegistry(ctx);
  const allPacksBefore = await registry.all();
  const packsBefore = allPacksBefore.length;

  if (await shouldDeclineForAuto(ctx, opts.auto, looseObjectsBefore)) {
    return {
      ran: false,
      result: { ...GC_NOT_RUN, looseObjectsBefore, packsBefore, packsAfter: packsBefore },
    };
  }

  await assertValidBooleanConfig(ctx, 'gc', undefined, ['cruftPacks']);
  const config = await readConfig(ctx);
  const cruftPacksEnabled = config.gc?.cruftPacks ?? true;
  const cutoff = expiryCutoff(config.gc?.pruneExpire ?? DEFAULT_PRUNE_EXPIRE, {});

  // --- step 1b: classify every pack, lstat every pack, before any write ---
  const fileNames = await registry.fileNames();
  const classification = classifyPackFiles(allPacksBefore, fileNames);
  const statByName = await lstatPacks(ctx, allPacksBefore);
  const packBytesBefore = sumPackBytes([...statByName.values()]);
  const existingNormalNames = new Set(classification.normal.map((pack) => pack.name));
  const existingPromisorNames = new Set(classification.promisor.map((pack) => pack.name));

  const keptOids = await unionOids(classification.kept);
  const ownedPromisor = await unionOids(classification.promisor);
  const { oids: normalOids, mtimeOf: normalPackMtimeOf } = await collectNormalPackData(
    classification.normal,
    statByName,
  );

  // --- step 2: existing cruft pack(s) — classification.cruft already
  // excludes a pack that ALSO carries .keep (Pin V), so it is never
  // treated as existing cruft here nor retired below.
  const existingCruft = await readExistingCruftPack(ctx, classification.cruft);
  const existingCruftShas = new Set(existingCruft.packShas);

  // --- step 3/4: retention roots, reachability, the widened partition ---
  const owned = new Set<ObjectId>([...looseSet, ...existingCruft.mtimes.keys(), ...normalOids]);
  const reachable = await computeReachableSet(ctx);
  const { toNormalPack, cruftCandidates } = partitionOwned(
    owned,
    reachable,
    keptOids,
    ownedPromisor,
  );
  // toPromisorPack is the WHOLE promisor set, never intersected with
  // `reachable`: a promisor pack has no way to carry a "still needed
  // locally" flag per object, so an unreachable member can only be carried
  // forward (never crufted — a cruft pack cannot carry the `.promisor`
  // marker — and never destroyed by the expiry cutoff, which never sees it).
  // Two verdicts pinned against git 2.55.0 (mktemp probes, scrubbed env):
  // (1) an UNREACHABLE object living only inside a `.promisor`-marked pack
  // is retained in the rebuilt promisor pack (never crufted, never
  // dropped) — the design's "retain" default needed no correction. (2) a
  // REACHABLE promisor-pack object is packed into BOTH the rebuilt
  // promisor pack (here) AND the ordinary normal pack (`partitionOwned`
  // above) — git does not exclude promisor membership from the normal
  // pack the way it excludes `.keep`, so `toNormalPack` and this set
  // deliberately intersect on every reachable promisor oid.
  //
  // Sorted for the SAME reason `partitionOwned` sorts `toNormalPack` (Pin
  // W): `unionOids` appends each promisor pack's own oid list in
  // CLASSIFICATION order, not merged-sorted, so consolidating more than one
  // promisor pack would otherwise churn `buildPack`'s array-order entries —
  // and with it the promisor pack's sha — on every run whose pack-discovery
  // order happens to differ, even though the object SET never changed.
  const toPromisorPack: ReadonlyArray<ObjectId> = [...ownedPromisor].sort();

  const mtimes = await computeCruftMtimes(
    ctx,
    cruftCandidates,
    looseSet,
    existingCruft.mtimes,
    normalPackMtimeOf,
  );
  // --- step 5: the expiry cutoff ---
  const { survivors, doomed } = partitionByCutoff(cruftCandidates, mtimes, cutoff);

  // --- every write starts here; every refusal above leaves the store untouched ---
  const normalPack = await buildAndWriteNormalPack(
    ctx,
    packDir,
    toNormalPack,
    existingCruftShas,
    existingNormalNames,
  );
  const promisorPack = await buildAndWritePromisorPack(
    ctx,
    packDir,
    toPromisorPack,
    existingPromisorNames,
  );
  const cruftOutcome = await applyCruftOutcome(
    ctx,
    packDir,
    cruftPacksEnabled,
    survivors,
    existingCruft,
    looseSet,
    mtimes,
  );

  // --- step 8: refresh, then verify every object just packed ---
  refreshPackRegistry(ctx);
  const verifyTargets = [...toNormalPack, ...toPromisorPack, ...survivors];
  await boundedMapFor(ctx, 'ioBound', verifyTargets, (id) =>
    readObject(ctx, id, { verifyHash: true }),
  );

  // --- step 9: prune loose ---
  const packed = await packedAnywhere(ctx, looseSet);
  const doomedSet = new Set(doomed);
  const unlink = new Set<ObjectId>(packed);
  for (const id of doomedSet) if (looseSet.has(id)) unlink.add(id);
  await pruneLooseFiles(ctx, unlink);

  // Every doomed object is truly gone from the store from this point on —
  // drop it from the byte cache and the parsed-object memo too, or a
  // destroyed object would keep reading back successfully from a cache
  // neither of which has any concept of an object having been removed.
  for (const id of doomedSet) {
    ctx.deltaCache.delete(id);
    // Stryker disable next-line CallExpression: equivalent — `resolveObject` (object-resolver.ts) always calls `resolveObjectBytesWithDepth` first, which independently re-verifies existence via the just-cleared `ctx.deltaCache`, the (now-unlinked) loose file, and the (already-refreshed) pack registry, throwing `objectNotFound` before this memo is ever consulted; content-addressing also means any surviving entry could never disagree with a fresh parse of the same oid.
    forgetParsedObjectMemo(ctx, id);
  }

  // --- steps 9b/10/10b/10c: retire every superseded pack, cruft, normal and promisor ---
  const reusedCruftSha = normalPack.reuse === 'cruft' ? (normalPack.packId as string) : undefined;
  if (reusedCruftSha !== undefined) {
    await declassifyCruftPack(ctx, packDir, reusedCruftSha);
  }

  // Stryker disable next-line ConditionalExpression: equivalent — the sole reader is the `pack.name !== reusedNormalName` filter below; `pack-${normalPack.packId}` can equal an EXISTING classification.normal pack's name if and only if `reuse === 'normal'` (identical predicate, `existingNormalNames.has('pack-' + pack.sha)`, in buildAndWriteNormalPack), so forcing this ternary's true-branch unconditionally never matches a real pack.name when reuse isn't actually 'normal' — same as `undefined`.
  const reusedNormalName = normalPack.reuse === 'normal' ? `pack-${normalPack.packId}` : undefined;
  const normalPacksToRetire = classification.normal.filter(
    (pack) => pack.name !== reusedNormalName,
  );
  const cruftShasToRetire = existingCruft.packShas.filter(
    (sha) => sha !== cruftOutcome.cruftPackId && sha !== reusedCruftSha,
  );
  const promisorPacksToRetire = classification.promisor.filter(
    (pack) => pack.name !== promisorPack.reusedExistingName,
  );

  // A multi-pack-index naming any pack about to be retired must be expired
  // BEFORE that pack's own unlink — a midx surviving even briefly past its
  // first named pack's removal is a reader-visible dangling reference,
  // exactly the window `retireNormalPack`/`retireCruftPack`/
  // `retirePromisorPack`'s own "`.idx` first" ordering exists to avoid one
  // level up.
  const retiredIdxNames = new Set<string>([
    ...normalPacksToRetire.map((pack) => `${pack.name}.idx`),
    ...cruftShasToRetire.map((sha) => `pack-${sha}.idx`),
    ...promisorPacksToRetire.map((pack) => `${pack.name}.idx`),
  ]);
  await expireMidxIfNeeded(ctx, packDir, retiredIdxNames);

  await retireSupersededPacks(
    ctx,
    registry,
    packDir,
    normalPacksToRetire,
    cruftShasToRetire,
    promisorPacksToRetire,
  );

  // --- stale tmp_ litter removal — runs after every pack write and
  // retirement this run performs, the same tail-of-prune position git's own
  // `remove_temporary_files` occupies (see removeStaleTempFiles' own doc for
  // the full placement rationale).
  await removeStaleTempFiles(ctx, packDir, cutoff);

  // --- step 11: invalidate, refresh, packBytesAfter ---
  // Stryker disable next-line CallExpression: equivalent — the registry's dirty-flag/lazy-rescan model (`refreshPackRegistry` marks dirty; the NEXT `.all()`/`.lookup()` call performs the actual re-scan) means this call is always redundant with an earlier one: every pack write in this run happens before step 8's own `refreshPackRegistry` + the registry calls inside the verify/packedAnywhere loops (so those already observe every write), and `retireSupersededPacks` performs its OWN `registry.refresh()` immediately before any unlink whenever it retires anything — so `getPackRegistry(ctx).all()` below always re-scans against a state already known-fresh, with or without this line — confirmed empirically (hand-applied CallExpression removal, full covering set still green).
  refreshPackRegistry(ctx);
  const allPacksAfter = await getPackRegistry(ctx).all();
  const packsAfter = allPacksAfter.length;
  const afterStats = await lstatPacks(ctx, allPacksAfter);
  const packBytesAfter = sumPackBytes([...afterStats.values()]);

  const existingCruftKeys = new Set(existingCruft.mtimes.keys());
  const cruftObjectsAdded = survivors.filter((id) => !existingCruftKeys.has(id)).length;
  const cruftObjectsRetained = survivors.filter((id) => existingCruftKeys.has(id)).length;

  return {
    ran: true,
    result: {
      looseObjectsBefore,
      looseObjectsPacked: packed.size,
      prunedLooseObjects: unlink.size,
      packsBefore,
      packsAfter,
      packId: normalPack.packId,
      cruftObjectsAdded,
      cruftObjectsRetained,
      cruftObjectsExpired: doomed.length,
      cruftPackId: cruftOutcome.cruftPackId,
      promisorPackId: promisorPack.packId,
      packsRetired:
        normalPacksToRetire.length + cruftShasToRetire.length + promisorPacksToRetire.length,
      packBytesBefore,
      packBytesAfter,
    },
  };
}

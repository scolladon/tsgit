/**
 * The cruft pack's lifecycle: discovering the existing cruft pack(s) and
 * their `.mtimes` sidecars, computing mtime provenance for unreachable
 * candidates, deciding what the next `gc` does to the cruft pack, and the
 * physical write/retire operations that decision drives.
 *
 * mtime provenance has three sources — a loose file's own `lstat`, a
 * carried-forward sidecar entry, and a superseded NORMAL pack's own
 * `lstat` (an object gc is about to consolidate out of an existing pack
 * carries that pack's mtime, not the run's clock) — combined by `Math.max`,
 * never a lookup with a fallback.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  type PackIndexWriterEntry,
  parseCruftMtimes,
  sortPackIndexEntries,
} from '../../../domain/storage/index.js';
import { allObjectIds } from '../../../domain/storage/pack-index.js';
import type { Context } from '../../../ports/context.js';
import type { RegisteredPack } from '../pack-registry.js';
import { commonGitDir, looseObjectPath, packsDir } from '../path-layout.js';
import { boundedMapFor } from './concurrency.js';
import { errorDataCode } from './error-data-code.js';
import {
  buildCruftMtimes,
  cruftMtimesFilePath,
  packFilePath,
  writePackArtifacts,
} from './write-pack-artifacts.js';

const CRUFT_HEADER_SIZE = 12;

export interface ExistingCruftPack {
  /** oid → mtime (seconds) — the UNION across every `.mtimes` sidecar found,
   *  merged by `Math.max` on a shared oid (never a `Date.now()` fallback). */
  readonly mtimes: ReadonlyMap<ObjectId, number>;
  /**
   * Every existing cruft pack's trailer sha, normally 0 or 1 entries. A
   * crash between step 7's write and step 10's retirement can leave TWO
   * valid cruft packs, both read here — the next `gc` treats their union as
   * `existingCruft` and retires all but the one it writes.
   */
  readonly packShas: ReadonlyArray<string>;
}

const NO_EXISTING_CRUFT: ExistingCruftPack = { mtimes: new Map(), packShas: [] };

/** The `.mtimes` sidecar's own hash-id byte, peeked without trusting the
 *  rest of the header — used only to size the self-checksum slice safely. */
function peekDigestLength(bytes: Uint8Array): number | undefined {
  if (bytes.length < CRUFT_HEADER_SIZE) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hashId = view.getUint32(8);
  if (hashId === 1) return 20;
  if (hashId === 2) return 32;
  return undefined;
}

/**
 * The caller-computed self-checksum `parseCruftMtimes` compares against the
 * trailer, or `undefined` when the file is not even the right LENGTH for a
 * hash width its own header claims — in that case `parseCruftMtimes` itself
 * throws the appropriate structural refusal (size/hashId/count) without this
 * helper inventing one first.
 */
async function candidateSelfChecksum(
  ctx: Context,
  bytes: Uint8Array,
  objectCount: number,
): Promise<Uint8Array | undefined> {
  const digestLength = peekDigestLength(bytes);
  if (digestLength === undefined) return undefined;
  const trailerStart = CRUFT_HEADER_SIZE + 4 * objectCount + digestLength;
  if (bytes.length !== trailerStart + digestLength) return undefined;
  return ctx.hash.hash(bytes.subarray(0, trailerStart));
}

/** Merges one `.mtimes` sidecar's parsed entries into the running union —
 *  `Math.max` on a shared oid, never a plain overwrite. */
function mergeMtimesInto(
  target: Map<ObjectId, number>,
  source: ReadonlyMap<ObjectId, number>,
): void {
  for (const [id, mtime] of source) {
    const prior = target.get(id);
    target.set(id, prior === undefined ? mtime : Math.max(prior, mtime));
  }
}

/** Parses one classified-cruft pack's `.mtimes` sidecar against its own
 *  `.idx`'s oid list. `pack` is already a REGISTERED pack drawn from
 *  `classifyPackFiles`'s `cruft` bucket (Pin V: a pack carrying `.keep`
 *  classifies as `kept`, never `cruft`, even when it ALSO carries
 *  `.mtimes` — so a kept pack's sidecar is never read here, never merged
 *  into the union, and never becomes a retirement candidate). */
async function readOneCruftSidecar(
  ctx: Context,
  dir: string,
  pack: RegisteredPack,
): Promise<{ readonly packSha: string; readonly mtimes: ReadonlyMap<ObjectId, number> }> {
  const oidsInIndexOrder = allObjectIds(await pack.index());
  const bytes = await ctx.fs.read(cruftMtimesFilePath(dir, pack.name.slice('pack-'.length)));
  const selfChecksum = await candidateSelfChecksum(ctx, bytes, oidsInIndexOrder.length);
  const mtimes = parseCruftMtimes(bytes, oidsInIndexOrder, selfChecksum);
  return { packSha: pack.name.slice('pack-'.length), mtimes };
}

const byPackName = (a: RegisteredPack, b: RegisteredPack): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Parse the repository's existing cruft pack(s) — `cruftPacks` is
 * `classifyPackFiles`'s own `cruft` bucket (Pin V total exclusion: a
 * `.keep`-marked pack classifies as `kept`, never reaches here even when
 * it ALSO carries `.mtimes`). Normally at most one is present; a crash
 * between step 7's write and step 10's retirement can leave TWO, both
 * valid — every one is read and merged into a single UNION map (`Math.max`
 * per shared oid), and every sha is returned so the caller retires all but
 * the one it writes.
 *
 * A `.mtimes` whose object count disagrees with its sibling `.idx`, or
 * whose self-checksum fails, is a typed refusal (`INVALID_CRUFT_MTIMES`)
 * that reads nothing further — never a silently empty map.
 */
export async function readExistingCruftPack(
  ctx: Context,
  cruftPacks: ReadonlyArray<RegisteredPack>,
): Promise<ExistingCruftPack> {
  if (cruftPacks.length === 0) return NO_EXISTING_CRUFT;
  const dir = packsDir(commonGitDir(ctx));
  const mergedMtimes = new Map<ObjectId, number>();
  const packShas: string[] = [];
  for (const pack of [...cruftPacks].sort(byPackName)) {
    const found = await readOneCruftSidecar(ctx, dir, pack);
    mergeMtimesInto(mergedMtimes, found.mtimes);
    packShas.push(found.packSha);
  }
  return { mtimes: mergedMtimes, packShas };
}

/** `Math.max` over the sources that are actually present — never a
 *  `Date.now()` fallback, and never a lookup-with-precedence. */
function maxDefined(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b as number;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** Whole seconds since epoch — the `.mtimes` sidecar's own unit — from a
 *  loose object file's `lstat`. Never catches: a failed `lstat` is a
 *  refusal, not a reason to fall back to the current time. */
async function looseMtimeSeconds(ctx: Context, id: ObjectId): Promise<number> {
  const stat = await ctx.fs.lstat(looseObjectPath(commonGitDir(ctx), id));
  return Math.floor(stat.mtimeMs / 1000);
}

/**
 * Mtime provenance for every unreachable candidate: the `max` over THREE
 * sources — the loose file's own `lstat` (when the object is loose), the
 * carried sidecar entry (when it survived from an existing cruft pack), and
 * a superseded NORMAL pack's own `lstat` (when the object is migrating out
 * of a pack consolidation is about to retire) — an object can legitimately
 * have more than one source at once (the "freshen" case), and the newer one
 * always wins. Every candidate has at least one source by construction (it
 * entered `owned` through loose, the existing cruft sidecar, or a normal
 * pack). Fanned across the `ioBound` pool: each candidate's `lstat` is
 * independent of every other's.
 */
export async function computeCruftMtimes(
  ctx: Context,
  candidates: ReadonlyArray<ObjectId>,
  looseSet: ReadonlySet<ObjectId>,
  existingCruft: ReadonlyMap<ObjectId, number>,
  normalPackMtimeOf: ReadonlyMap<ObjectId, number>,
): Promise<ReadonlyMap<ObjectId, number>> {
  const pairs = await boundedMapFor(ctx, 'ioBound', candidates, async (id) => {
    const looseMtime = looseSet.has(id) ? await looseMtimeSeconds(ctx, id) : undefined;
    const carried = existingCruft.get(id);
    const fromNormalPack = normalPackMtimeOf.get(id);
    return [id, maxDefined(maxDefined(looseMtime, carried), fromNormalPack)] as const;
  });
  return new Map(pairs);
}

export type CruftFate = 'noop' | 'delete' | 'rewrite';

/**
 * The three-way branch, evaluated as a set comparison, never a schedule:
 * the survivor set unchanged from the existing cruft pack's own key set is
 * a no-op (byte-identical, same name); an empty survivor set deletes the
 * cruft pack outright; anything else rewrites it under a new sha.
 *
 * `existingCruftPackCount` gates the no-op branch to EXACTLY one existing
 * cruft pack: the two-cruft-pack crash-recovery state always has litter to
 * collapse, even when the merged key set happens to match the survivor set,
 * so `noop` is never reachable there — the union always rewrites into one.
 */
export function decideCruftFate(
  survivors: ReadonlyArray<ObjectId>,
  existingCruftKeys: ReadonlySet<ObjectId>,
  existingCruftPackCount: number,
): CruftFate {
  const unchanged =
    existingCruftPackCount === 1 &&
    survivors.length === existingCruftKeys.size &&
    survivors.every((id) => existingCruftKeys.has(id));
  if (unchanged) return 'noop';
  return survivors.length === 0 ? 'delete' : 'rewrite';
}

export interface WrittenCruftPack {
  readonly packSha: string;
}

/**
 * Builds and writes a fresh cruft pack: `.pack`/`.idx`/optional `.rev`
 * (`writePackArtifacts` unchanged) followed by `.mtimes` last — mirroring
 * retirement's own "marker last" ordering: until `.mtimes` exists, the pack
 * reads as an ordinary one, never as a half-written cruft pack.
 */
export async function writeCruftPack(
  ctx: Context,
  input: {
    readonly packDir: string;
    readonly entries: ReadonlyArray<PackIndexWriterEntry>;
    readonly packBytes: Uint8Array;
    readonly packSha: string;
    readonly mtimeOf: (id: ObjectId) => number;
  },
): Promise<WrittenCruftPack> {
  const written = await writePackArtifacts(ctx, {
    packDir: input.packDir,
    packBytes: input.packBytes,
    entries: input.entries,
    packSha: input.packSha,
    promisor: false,
  });
  const sorted = sortPackIndexEntries(input.entries);
  const mtimesBytes = await buildCruftMtimes(
    ctx,
    input.entries,
    written.packSha,
    input.mtimeOf,
    sorted,
  );
  await ctx.fs.writeExclusive(cruftMtimesFilePath(input.packDir, written.packSha), mtimesBytes);
  return { packSha: written.packSha };
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
 * Retires a superseded cruft pack's four siblings — `.idx` FIRST (removes
 * it from every reader's candidate scan in one unlink, so everything after
 * operates on litter) and `.mtimes` LAST (so the only reachable partial
 * state reads as an ordinary pack, objects retained, ages forgotten — never
 * a sidecar with no pack). `.rev` is tolerated absent
 * (`pack.writeReverseIndex` off).
 */
export async function retireCruftPack(
  ctx: Context,
  packDir: string,
  packSha: string,
): Promise<void> {
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.idx`);
  await rmTolerant(ctx, packFilePath(packDir, packSha));
  await rmTolerant(ctx, `${packDir}/pack-${packSha}.rev`);
  await rmTolerant(ctx, cruftMtimesFilePath(packDir, packSha));
}

/**
 * Drops ONLY the `.mtimes` sidecar, leaving `.pack`/`.idx`/`.rev` in place —
 * the collision case where the cruft pack's entire object set migrated
 * intact into the normal pack under the identical sha (`buildPack` is
 * deterministic, so an object moving cruft → normal reproduces the exact
 * same bytes when it was the cruft pack's only member). The pack itself is
 * not garbage; only its cruft classification is, so `retireCruftPack`'s
 * full four-file removal would destroy the very bytes the normal pack now
 * needs.
 */
export async function declassifyCruftPack(
  ctx: Context,
  packDir: string,
  packSha: string,
): Promise<void> {
  await rmTolerant(ctx, cruftMtimesFilePath(packDir, packSha));
}

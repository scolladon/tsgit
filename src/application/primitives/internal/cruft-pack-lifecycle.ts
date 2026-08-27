/**
 * The cruft pack's lifecycle: discovering an existing cruft pack and its
 * `.mtimes` sidecar, computing mtime provenance for unreachable candidates,
 * deciding what the next `gc` does to it, and the physical write/retire
 * operations that decision drives.
 *
 * mtime provenance has exactly two sources in this part's scope — a loose
 * file's own `lstat`, and a carried-forward sidecar entry — because `gc`
 * here never touches a pre-existing NORMAL pack (that is a later part's
 * consolidation). The third source (a superseded pack's own mtime) joins
 * this rule once that scope lands.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  type PackIndexWriterEntry,
  parseCruftMtimes,
  sortPackIndexEntries,
} from '../../../domain/storage/index.js';
import { allObjectIds } from '../../../domain/storage/pack-index.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir, looseObjectPath, packsDir } from '../path-layout.js';
import { getPackRegistry } from '../read-object.js';
import { boundedMapFor } from './concurrency.js';
import { errorDataCode } from './error-data-code.js';
import { isSafePackName, packBaseName } from './pack-shared.js';
import {
  buildCruftMtimes,
  cruftMtimesFilePath,
  packFilePath,
  writePackArtifacts,
} from './write-pack-artifacts.js';

const CRUFT_HEADER_SIZE = 12;

export interface ExistingCruftPack {
  /** oid → mtime (seconds), keyed by the sidecar's own `.idx`-order oid list. */
  readonly mtimes: ReadonlyMap<ObjectId, number>;
  /** The existing cruft pack's trailer sha, or `undefined` when none exists. */
  readonly packSha: string | undefined;
}

const NO_EXISTING_CRUFT: ExistingCruftPack = { mtimes: new Map(), packSha: undefined };

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

function isMissingDir(error: unknown): boolean {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
}

/**
 * Discover and parse the repository's existing cruft pack, if any. At most
 * one `.mtimes` sidecar is expected at this part's scope (multi-cruft-pack
 * crash recovery belongs to a later part's consolidation classifier); when
 * more than one is somehow present, the lexicographically first is read,
 * deterministically.
 *
 * A `.mtimes` whose object count disagrees with its sibling `.idx`, or
 * whose self-checksum fails, is a typed refusal (`INVALID_CRUFT_MTIMES`)
 * that reads nothing further — never a silently empty map.
 */
export async function readExistingCruftPack(ctx: Context): Promise<ExistingCruftPack> {
  const dir = packsDir(commonGitDir(ctx));
  let entries: ReadonlyArray<{ readonly isFile: boolean; readonly name: string }>;
  try {
    entries = await ctx.fs.readdir(dir);
  } catch (error) {
    if (isMissingDir(error)) return NO_EXISTING_CRUFT;
    throw error;
  }

  const mtimesName = entries
    .filter((e) => e.isFile && e.name.endsWith('.mtimes') && isSafePackName(e.name))
    .map((e) => e.name)
    .sort()[0];
  if (mtimesName === undefined) return NO_EXISTING_CRUFT;

  const base = packBaseName(`${mtimesName.slice(0, -'.mtimes'.length)}.idx`);
  const registeredPack = (await getPackRegistry(ctx).all()).find((p) => p.name === base);
  // An orphan `.mtimes` with no loadable `.idx`/`.pack` pair is invisible to
  // the registry exactly as an orphan `.idx` already is (`loadCandidatePack`)
  // — treated as no existing cruft pack, not a refusal of its own.
  if (registeredPack === undefined) return NO_EXISTING_CRUFT;

  const index = await registeredPack.index();
  const oidsInIndexOrder = allObjectIds(index);
  const bytes = await ctx.fs.read(`${dir}/${mtimesName}`);
  const selfChecksum = await candidateSelfChecksum(ctx, bytes, oidsInIndexOrder.length);
  const mtimes = parseCruftMtimes(bytes, oidsInIndexOrder, selfChecksum);
  return { mtimes, packSha: base.slice('pack-'.length) };
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
 * Mtime provenance for every unreachable candidate: the `max` over the
 * loose file's own `lstat` (when the object is loose) and the carried
 * sidecar entry (when it survived from an existing cruft pack) — an object
 * can legitimately have both at once (the "freshen" case), and the newer
 * one always wins. Fanned across the `ioBound` pool: each candidate's
 * `lstat` is independent of every other's.
 */
export async function computeCruftMtimes(
  ctx: Context,
  candidates: ReadonlyArray<ObjectId>,
  looseSet: ReadonlySet<ObjectId>,
  existingCruft: ReadonlyMap<ObjectId, number>,
): Promise<ReadonlyMap<ObjectId, number>> {
  const pairs = await boundedMapFor(ctx, 'ioBound', candidates, async (id) => {
    const looseMtime = looseSet.has(id) ? await looseMtimeSeconds(ctx, id) : undefined;
    const carried = existingCruft.get(id);
    return [id, maxDefined(looseMtime, carried)] as const;
  });
  return new Map(pairs);
}

export type CruftFate = 'noop' | 'delete' | 'rewrite';

/**
 * The three-way branch, evaluated as a set comparison, never a schedule:
 * the survivor set unchanged from the existing cruft pack's own key set is
 * a no-op (byte-identical, same name); an empty survivor set deletes the
 * cruft pack outright; anything else rewrites it under a new sha.
 */
export function decideCruftFate(
  survivors: ReadonlyArray<ObjectId>,
  existingCruftKeys: ReadonlySet<ObjectId>,
): CruftFate {
  const unchanged =
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

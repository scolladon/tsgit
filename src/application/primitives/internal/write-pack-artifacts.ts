/**
 * Shared `.pack` + `.idx` + `.rev` writer. Extracted out of `fetch-pack.ts`
 * so `pack-objects` (writing a locally-built pack) and `fetchPack` (writing
 * a negotiated one) share the exact same on-disk encoding — most notably
 * the `.idx`'s DOUBLE trailer: `serializePackIndex` already writes the
 * pack's own checksum as the file's first trailer, and the SHA over that
 * body is appended as a second one. Real git produces both; a reader that
 * stops after the first will not round-trip, so this logic is never
 * rewritten, only reused.
 *
 * The `.rev` write is gated by `pack.writeReverseIndex` (git default: true).
 * The gate is resolved before any artefact is created, so a refused config
 * value leaves the pack directory untouched — see `writeReverseIndex`.
 */
import { packArtifactMismatch } from '../../../domain/error.js';
import { bytesEqual, hexToBytes } from '../../../domain/objects/encoding.js';
import {
  type PackIndexEntries,
  type SortedPackIndex,
  serializeCruftMtimes,
  serializePackIndex,
  serializePackRevIndex,
  sortPackIndexEntries,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { assertValidBooleanConfig } from './boolean-config-guard.js';
import { errorDataCode } from './error-data-code.js';

export const buildIdx = async (
  ctx: Context,
  sorted: SortedPackIndex,
  packSha: string,
): Promise<Uint8Array> => {
  const packShaBytes = hexToBytes(packSha);
  const body = serializePackIndex(sorted, packShaBytes);
  // serializePackIndex writes the pack trailer SHA as the file's first checksum
  // (packShaBytes.length bytes at the tail of `body`, so 20 or 32 depending on
  // the repository's algorithm); parsePackIndex expects a second checksum
  // immediately after — the SHA over the body itself. Real git produces both;
  // we follow suit so subsequent `parsePackIndex` reads round-trip cleanly.
  const digestStart = body.length - ctx.hash.digestLength;
  const idxTrailerHex = await ctx.hash.hashHex(body.subarray(0, digestStart));
  body.set(hexToBytes(idxTrailerHex), digestStart);
  return body;
};

/**
 * Assembles a `.rev` file's bytes: `serializePackRevIndex` reserves the
 * trailer region zeroed; this fills it in place with the digest over
 * everything before it — the same body/trailer split `buildIdx` uses for
 * the `.idx`, one allocation, no concat.
 */
export const buildRev = async (
  ctx: Context,
  sorted: SortedPackIndex,
  packSha: string,
): Promise<Uint8Array> => {
  const packChecksum = hexToBytes(packSha);
  const bytes = serializePackRevIndex(sorted, packChecksum);
  // The trailer offset derives from the SAME width the serializer sized the
  // file with (`packChecksum.length`), never from `ctx.hash.digestLength` —
  // one width source, so a hash/pack width disagreement overflows loudly in
  // `set` instead of silently landing the digest inside the checksum field.
  const trailerStart = bytes.length - packChecksum.length;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);
  return bytes;
};

/**
 * Assembles a cruft pack's `.mtimes` sidecar bytes: `serializeCruftMtimes`
 * reserves the trailer's self-checksum region zeroed; this fills it in
 * place, the same body/trailer split `buildRev` uses for `.rev` (Pin P
 * confirms the digest covers the pack-checksum field identically).
 */
export const buildCruftMtimes = async (
  ctx: Context,
  sorted: SortedPackIndex,
  packSha: string,
  mtimeAt: (ordinal: number) => number,
): Promise<Uint8Array> => {
  const packChecksum = hexToBytes(packSha);
  const bytes = serializeCruftMtimes(sorted, packChecksum, mtimeAt);
  // Same one-width-source rule buildRev documents: the trailer offset comes
  // from the width the serializer actually sized the file with.
  const trailerStart = bytes.length - packChecksum.length;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);
  return bytes;
};

/** The cruft pack's mtime sidecar path — a plain sibling, `pack-<sha>.mtimes`. */
export const cruftMtimesFilePath = (packDir: string, packSha: string): string =>
  `${packDir}/pack-${packSha}.mtimes`;

const WRITE_REVERSE_INDEX_KEY = 'writeReverseIndex'; // the finders lower-case their key list

/**
 * `pack.writeReverseIndex`'s gate. Must run before ANY read of the field:
 * a refused value is left absent in `ParsedConfig`, so a bare `?? true`
 * cannot tell "refused" from "unset". Guarding first is what makes that
 * fallback safe.
 */
const writeReverseIndex = async (ctx: Context): Promise<boolean> => {
  await assertValidBooleanConfig(ctx, 'pack', undefined, [WRITE_REVERSE_INDEX_KEY]);
  return (await readConfig(ctx)).pack?.writeReverseIndex ?? true;
};

export interface WritePackArtifactsInput {
  readonly packDir: string;
  readonly packBytes: Uint8Array;
  readonly entries: PackIndexEntries;
  readonly packSha: string;
  readonly promisor: boolean;
}

export interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  /** Byte length of the written `.idx` — callers no longer recompute it. */
  readonly indexBytes: number;
  readonly packSha: string;
  /** The oid-ascending permutation this write already computed. Handed back so
   *  a caller writing a further artefact over the same slab — the cruft
   *  `.mtimes` is the only one — does not sort it a second time. */
  readonly sorted: SortedPackIndex;
}

interface ArtifactPaths {
  readonly packPath: string;
  readonly idxPath: string;
  readonly promisorPath: string;
  readonly revPath: string;
}

/** The on-disk path for a pack keyed by its trailer SHA — shared by every
 *  writer of `.pack` bytes so quarantine-rename callers (fetch-pack) and
 *  from-scratch writers (pack-objects) agree on the exact same name. */
export const packFilePath = (packDir: string, packSha: string): string =>
  `${packDir}/pack-${packSha}.pack`;

/** The on-disk path for a pack's `.idx` sibling, keyed the same way as
 *  `packFilePath` — shared so a caller checking whether a pack is already
 *  present (fetch-pack) and this module's own writer agree on the exact
 *  same name. */
export const packIdxFilePath = (packDir: string, packSha: string): string =>
  `${packDir}/pack-${packSha}.idx`;

const artifactPaths = (packDir: string, packSha: string): ArtifactPaths => ({
  packPath: packFilePath(packDir, packSha),
  idxPath: packIdxFilePath(packDir, packSha),
  promisorPath: `${packDir}/pack-${packSha}.promisor`,
  revPath: `${packDir}/pack-${packSha}.rev`,
});

/** Writes `bytes` at `path` unless an identical artefact already occupies
 *  it — git's finalize step keeps an identical file in place and reports a
 *  mismatch on anything else, never overwriting. */
const writeOrKeepArtifact = async (
  ctx: Context,
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  try {
    await ctx.fs.writeExclusive(path, bytes);
  } catch (err) {
    if (errorDataCode(err) !== 'FILE_EXISTS') throw err;
    if (!bytesEqual(await ctx.fs.read(path), bytes)) throw packArtifactMismatch(path);
  }
};

// A promisor pack vouches for the objects it references but omits; the
// `.promisor` sentinel marks it so missing objects read as promised. An
// existing sentinel is kept whatever it holds — git writes free-form text there.
const writeSentinelIfAbsent = async (ctx: Context, path: string): Promise<void> => {
  try {
    await ctx.fs.writeExclusive(path, new Uint8Array(0));
  } catch (err) {
    if (errorDataCode(err) !== 'FILE_EXISTS') throw err;
  }
};

const writeRevArtifact = async (
  ctx: Context,
  path: string,
  sorted: SortedPackIndex,
  packSha: string,
): Promise<void> => {
  const revBytes = await buildRev(ctx, sorted, packSha);
  await writeOrKeepArtifact(ctx, path, revBytes);
};

export interface WritePackSiblingArtifactsInput {
  readonly packDir: string;
  readonly entries: PackIndexEntries;
  readonly packSha: string;
  readonly promisor: boolean;
}

/**
 * Shared tail once `wantRev` is already resolved — `.idx`, an optional
 * `.promisor` sentinel, then `.rev` last if it isn't refused (see
 * `writePackArtifacts`'s docstring for why `.rev` is ordered last). Kept
 * separate from `writePackSiblingArtifacts` so `writePackArtifacts` can
 * resolve the gate BEFORE writing `.pack` — a refused config value must
 * leave the pack directory untouched, not just the `.idx`/`.rev` pair.
 * Each sibling is written only where its name is free: an identical
 * occupant is kept, a differing one is refused — git's finalize posture.
 */
const writeSiblingsGiven = async (
  ctx: Context,
  input: WritePackSiblingArtifactsInput,
  wantRev: boolean,
): Promise<WrittenPackArtifacts> => {
  const paths = artifactPaths(input.packDir, input.packSha);
  await ctx.fs.mkdir(input.packDir);
  // One oid sort per pack write, shared by the `.idx` and `.rev` serializers —
  // the sort is the most expensive step of either artefact's assembly.
  const sorted = sortPackIndexEntries(input.entries);
  const idxBytes = await buildIdx(ctx, sorted, input.packSha);
  await writeOrKeepArtifact(ctx, paths.idxPath, idxBytes);
  if (input.promisor) await writeSentinelIfAbsent(ctx, paths.promisorPath);
  if (wantRev) await writeRevArtifact(ctx, paths.revPath, sorted, input.packSha);
  return {
    packPath: paths.packPath,
    idxPath: paths.idxPath,
    objectCount: input.entries.count,
    indexBytes: idxBytes.length,
    packSha: input.packSha,
    sorted,
  };
};

/**
 * Writes a pack's SIBLING artefacts only — `.idx`, an optional `.promisor`
 * sentinel, then — unless `pack.writeReverseIndex` refuses it — `.rev` last.
 * The `.pack` file itself is assumed already in place under `packFilePath`;
 * a caller that quarantines and renames its own pack bytes (fetch-pack)
 * reuses this instead of `writePackArtifacts`, which would re-write a
 * `.pack` that already exists and fail with `FILE_EXISTS`.
 */
export const writePackSiblingArtifacts = async (
  ctx: Context,
  input: WritePackSiblingArtifactsInput,
): Promise<WrittenPackArtifacts> =>
  await writeSiblingsGiven(ctx, input, await writeReverseIndex(ctx));

/**
 * Writes a pack's `.pack` bytes followed by its sibling artefacts, in git's
 * own order: `.pack`, `.idx`, an optional `.promisor` sentinel immediately
 * after, then — unless `pack.writeReverseIndex` refuses it — the `.rev`
 * last. `.rev` last is load-bearing: `pack-registry.ts` keys pack discovery
 * on the `.pack`/`.idx` pair, so a concurrent reader that observes the pair
 * before the `.rev` lands simply takes the absent-artefact arm — the same
 * state git itself leaves behind under `pack.writeReverseIndex=false`. The
 * gate is resolved before ANY write, `.pack` included, so a refused config
 * value leaves the pack directory untouched.
 */
export const writePackArtifacts = async (
  ctx: Context,
  input: WritePackArtifactsInput,
): Promise<WrittenPackArtifacts> => {
  const wantRev = await writeReverseIndex(ctx);
  const packPath = packFilePath(input.packDir, input.packSha);
  await ctx.fs.writeExclusive(packPath, input.packBytes);
  return await writeSiblingsGiven(ctx, input, wantRev);
};

// git's own quarantine prefix pair (Pin B, Pin X): `tmp_pack_<6>` and
// `tmp_idx_<6>`, written before either lands under its final name.
const TMP_PACK_PREFIX = 'tmp_pack_';
const TMP_IDX_PREFIX = 'tmp_idx_';
const TMP_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TMP_SUFFIX_LENGTH = 6;

/** Not security-sensitive (the containing directory is already trusted) —
 *  matches this codebase's other non-cryptographic tokens. */
const randomTmpSuffix = (): string => {
  let suffix = '';
  for (let i = 0; i < TMP_SUFFIX_LENGTH; i += 1) {
    suffix += TMP_SUFFIX_ALPHABET[Math.floor(Math.random() * TMP_SUFFIX_ALPHABET.length)];
  }
  return suffix;
};

/** Renames `tmpPath` into `finalPath`, preferring the platform's atomic
 *  replace where available and falling back to plain `rename` where it is
 *  not (OPFS) — see `ports/file-system.ts`'s `atomicRename` doc. Both
 *  replace an existing file at `finalPath`, which is exactly what a
 *  same-sha rewrite needs. */
const renameIntoPlace = async (ctx: Context, tmpPath: string, finalPath: string): Promise<void> => {
  const rename = ctx.fs.atomicRename ?? ctx.fs.rename;
  await rename(tmpPath, finalPath);
};

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
 * Writes a pack's `.pack` and `.idx` through git's own quarantine-then-
 * rename ordering (Pin X: `tmp_pack_<6>`/`tmp_idx_<6>` streamed first,
 * renamed to their final names only once complete) instead of
 * `writeExclusive` straight at the final path. This is the ONLY writer that
 * must tolerate a target already occupied by a pack of the exact same name:
 * a consolidating `gc` rewriting a pack whose freshly-built bytes happen to
 * reproduce an EXISTING pack byte-for-byte (Pin W's no-op boundary — git
 * rewrites even an unchanged single pack, every run) still needs that
 * file's mtime refreshed, because Pin Y makes a `.pack`'s own mtime the age
 * source for an object that later migrates out of it; `writeExclusive`
 * would refuse with `FILE_EXISTS`, and simply leaving the old file alone
 * would silently stale-date that clock. `.rev` is NOT quarantined — Pin X
 * names only the pack/idx pair — because it is cheap and fully
 * reconstructible from the SAME `entries` this call already has: any stale
 * sibling at the target name is removed first, then written fresh.
 */
export const writePackArtifactsViaQuarantine = async (
  ctx: Context,
  input: WritePackArtifactsInput,
): Promise<WrittenPackArtifacts> => {
  const wantRev = await writeReverseIndex(ctx);
  const paths = artifactPaths(input.packDir, input.packSha);
  await ctx.fs.mkdir(input.packDir);
  const sorted = sortPackIndexEntries(input.entries);
  const idxBytes = await buildIdx(ctx, sorted, input.packSha);

  const tmpPackPath = `${input.packDir}/${TMP_PACK_PREFIX}${randomTmpSuffix()}`;
  const tmpIdxPath = `${input.packDir}/${TMP_IDX_PREFIX}${randomTmpSuffix()}`;
  // A fault anywhere between the first quarantine write and the second
  // rename must not leave a `tmp_pack_*`/`tmp_idx_*` file behind: an
  // unlinked pack with no `.idx` is permanent debris (never discovered,
  // never cleaned up by any later gc, since pack discovery keys on `.idx`).
  // `renamed` tracks each temp file's true state — a path already renamed
  // away is untouched by the cleanup, everything else still at its tmp
  // location is removed.
  const renamed = { pack: false, idx: false };
  try {
    await ctx.fs.writeExclusive(tmpPackPath, input.packBytes);
    await ctx.fs.writeExclusive(tmpIdxPath, idxBytes);
    await renameIntoPlace(ctx, tmpPackPath, paths.packPath);
    renamed.pack = true;
    await renameIntoPlace(ctx, tmpIdxPath, paths.idxPath);
    renamed.idx = true;
  } finally {
    if (!renamed.pack) await rmTolerant(ctx, tmpPackPath);
    if (!renamed.idx) await rmTolerant(ctx, tmpIdxPath);
  }

  if (input.promisor) {
    // A same-sha rewrite (Pin W's no-op boundary, promisor class included)
    // finds its own sentinel from the PRIOR run still in place at this exact
    // path — `writeExclusive` alone would refuse with `FILE_EXISTS`, exactly
    // as the `.rev` write below tolerates the same shape of stale sibling.
    await rmTolerant(ctx, paths.promisorPath);
    await writeSentinelIfAbsent(ctx, paths.promisorPath);
  }
  if (wantRev) {
    await rmTolerant(ctx, paths.revPath);
    await writeRevArtifact(ctx, paths.revPath, sorted, input.packSha);
  }
  return {
    packPath: paths.packPath,
    idxPath: paths.idxPath,
    objectCount: input.entries.count,
    indexBytes: idxBytes.length,
    packSha: input.packSha,
    sorted,
  };
};

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
import { hexToBytes } from '../../../domain/objects/encoding.js';
import {
  type PackIndexWriterEntry,
  type SortedEntry,
  serializePackIndex,
  serializePackRevIndex,
  sortPackIndexEntries,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { assertValidBooleanConfig } from './boolean-config-guard.js';

export const buildIdx = async (
  ctx: Context,
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packSha: string,
  presorted?: ReadonlyArray<SortedEntry>,
): Promise<Uint8Array> => {
  const packShaBytes = hexToBytes(packSha);
  const body = serializePackIndex(entries, packShaBytes, presorted);
  // serializePackIndex writes the pack trailer SHA as the file's first checksum
  // (20 bytes at the tail of `body`); parsePackIndex expects a second checksum
  // immediately after — the SHA over the body itself. Real git produces both;
  // we follow suit so subsequent `parsePackIndex` reads round-trip cleanly.
  const idxTrailerHex = await ctx.hash.hashHex(body);
  const idxTrailerBytes = hexToBytes(idxTrailerHex);
  const out = new Uint8Array(body.length + idxTrailerBytes.length);
  out.set(body, 0);
  out.set(idxTrailerBytes, body.length);
  return out;
};

/**
 * Assembles a `.rev` file's bytes: `serializePackRevIndex` reserves the
 * trailer region zeroed; this fills it in place with the digest over
 * everything before it — the same body/trailer split `buildIdx` uses for
 * the `.idx`, one allocation, no concat.
 */
export const buildRev = async (
  ctx: Context,
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packSha: string,
  presorted?: ReadonlyArray<SortedEntry>,
): Promise<Uint8Array> => {
  const packChecksum = hexToBytes(packSha);
  const bytes = serializePackRevIndex(entries, packChecksum, presorted);
  // The trailer offset derives from the SAME width the serializer sized the
  // file with (`packChecksum.length`), never from `ctx.hash.digestLength` —
  // one width source, so a hash/pack width disagreement overflows loudly in
  // `set` instead of silently landing the digest inside the checksum field.
  const trailerStart = bytes.length - packChecksum.length;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  bytes.set(digest, trailerStart);
  return bytes;
};

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
  readonly entries: ReadonlyArray<PackIndexWriterEntry>;
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
}

interface ArtifactPaths {
  readonly packPath: string;
  readonly idxPath: string;
  readonly promisorPath: string;
  readonly revPath: string;
}

const artifactPaths = (packDir: string, packSha: string): ArtifactPaths => ({
  packPath: `${packDir}/pack-${packSha}.pack`,
  idxPath: `${packDir}/pack-${packSha}.idx`,
  promisorPath: `${packDir}/pack-${packSha}.promisor`,
  revPath: `${packDir}/pack-${packSha}.rev`,
});

// A promisor pack vouches for the objects it references but omits; the
// empty `.promisor` sentinel marks it so missing objects read as promised.
const writeEmptySentinel = (ctx: Context, path: string): Promise<void> =>
  ctx.fs.writeExclusive(path, new Uint8Array(0));

const writeRevArtifact = async (
  ctx: Context,
  path: string,
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packSha: string,
  presorted: ReadonlyArray<SortedEntry>,
): Promise<void> => {
  const revBytes = await buildRev(ctx, entries, packSha, presorted);
  await ctx.fs.writeExclusive(path, revBytes);
};

/**
 * Writes a pack's sibling artefacts in git's own order: `.pack`, `.idx`, an
 * optional `.promisor` sentinel immediately after, then — unless
 * `pack.writeReverseIndex` refuses it — the `.rev` last. `.rev` last is
 * load-bearing: `pack-registry.ts` keys pack discovery on the `.pack`/`.idx`
 * pair, so a concurrent reader that observes the pair before the `.rev`
 * lands simply takes the absent-artefact arm — the same state git itself
 * leaves behind under `pack.writeReverseIndex=false`.
 */
export const writePackArtifacts = async (
  ctx: Context,
  input: WritePackArtifactsInput,
): Promise<WrittenPackArtifacts> => {
  const wantRev = await writeReverseIndex(ctx);
  const paths = artifactPaths(input.packDir, input.packSha);
  await ctx.fs.mkdir(input.packDir);
  // One oid sort per pack write, shared by the `.idx` and `.rev` serializers —
  // the sort is the most expensive step of either artefact's assembly.
  const sorted = sortPackIndexEntries(input.entries);
  const idxBytes = await buildIdx(ctx, input.entries, input.packSha, sorted);
  await ctx.fs.writeExclusive(paths.packPath, input.packBytes);
  await ctx.fs.writeExclusive(paths.idxPath, idxBytes);
  if (input.promisor) await writeEmptySentinel(ctx, paths.promisorPath);
  if (wantRev) await writeRevArtifact(ctx, paths.revPath, input.entries, input.packSha, sorted);
  return {
    packPath: paths.packPath,
    idxPath: paths.idxPath,
    objectCount: input.entries.length,
    indexBytes: idxBytes.length,
    packSha: input.packSha,
  };
};

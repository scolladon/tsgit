/**
 * Shared `.pack` + `.idx` writer. Extracted out of `fetch-pack.ts` so
 * `pack-objects` (writing a locally-built pack) and `fetchPack` (writing a
 * negotiated one) share the exact same on-disk encoding — most notably the
 * `.idx`'s DOUBLE trailer: `serializePackIndex` already writes the pack's
 * own checksum as the file's first trailer, and the SHA over that body is
 * appended as a second one. Real git produces both; a reader that stops
 * after the first will not round-trip, so this logic is never rewritten,
 * only reused.
 */
import { hexToBytes } from '../../../domain/objects/encoding.js';
import { type PackIndexWriterEntry, serializePackIndex } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';

export const buildIdx = async (
  ctx: Context,
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packSha: string,
): Promise<Uint8Array> => {
  const writerEntries: PackIndexWriterEntry[] = entries.map((e) => ({
    id: e.id,
    crc32: e.crc32,
    offset: e.offset,
  }));
  const packShaBytes = hexToBytes(packSha);
  const body = serializePackIndex(writerEntries, packShaBytes);
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

export interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly packSha: string;
}

export const writePackArtifacts = async (
  ctx: Context,
  packDir: string,
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
  packSha: string,
  objectCount: number,
  promisor: boolean,
): Promise<WrittenPackArtifacts> => {
  await ctx.fs.mkdir(packDir);
  const packPath = `${packDir}/pack-${packSha}.pack`;
  const idxPath = `${packDir}/pack-${packSha}.idx`;
  await ctx.fs.writeExclusive(packPath, packBytes);
  await ctx.fs.writeExclusive(idxPath, idxBytes);
  // A promisor pack vouches for the objects it references but omits; the
  // empty `.promisor` sentinel marks it so missing objects read as promised.
  if (promisor) {
    await ctx.fs.writeExclusive(`${packDir}/pack-${packSha}.promisor`, new Uint8Array(0));
  }
  return { packPath, idxPath, objectCount, packSha };
};

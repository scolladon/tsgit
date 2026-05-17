/**
 * Phase 12.3 — non-delta packfile assembler (ADR-013).
 *
 * `buildPack` produces a v2 packfile containing every given oid as a base
 * entry (type 1-4). Each entry's content is the canonical loose-format
 * body (the bytes hashed to produce the oid) `deflate`d via the active
 * `ctx.compressor`. The pack trailer is the SHA over the body.
 *
 * The receiver (`git-receive-pack`) accepts the resulting pack because
 * it is self-contained: no REF_DELTA references, no OFS_DELTA back
 * pointers, no thin-pack assumptions.
 */
import { bytesToHex } from '../../domain/objects/encoding.js';
import type { ObjectType } from '../../domain/objects/index.js';
import { type GitObject, type ObjectId, serializeObject } from '../../domain/objects/index.js';
import {
  PACK_ENTRY_TYPE,
  type PackWriterEntry,
  serializePackfile,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';

export interface BuildPackInput {
  readonly oids: ReadonlyArray<ObjectId>;
}

export interface BuildPackResult {
  readonly bytes: Uint8Array;
  /** Hex SHA of the pack body, also the trailer (last 20 bytes). */
  readonly sha: string;
  readonly objectCount: number;
}

export const buildPack = async (ctx: Context, input: BuildPackInput): Promise<BuildPackResult> => {
  const writerEntries: PackWriterEntry[] = [];
  for (const oid of input.oids) {
    const object = await readObject(ctx, oid);
    writerEntries.push(await encodeEntry(ctx, object));
  }
  const packfile = serializePackfile(writerEntries);
  const trailerBytes = await ctx.hash.hash(packfile.data);
  const sha = bytesToHex(trailerBytes);
  const bytes = new Uint8Array(packfile.data.length + trailerBytes.length);
  bytes.set(packfile.data, 0);
  bytes.set(trailerBytes, packfile.data.length);
  return { bytes, sha, objectCount: writerEntries.length };
};

const encodeEntry = async (ctx: Context, object: GitObject): Promise<PackWriterEntry> => {
  const loose = serializeObject(object, ctx.hashConfig);
  const nul = loose.indexOf(0);
  // loose came from our own serializeObject which always writes
  // `<type> <size>\0...`, so `nul` is always > 0 by construction.
  const content = loose.subarray(nul + 1);
  const compressedData = await ctx.compressor.deflate(content);
  return {
    type: packEntryTypeFor(object.type),
    uncompressedSize: content.length,
    compressedData,
  };
};

const packEntryTypeFor = (
  type: ObjectType,
):
  | typeof PACK_ENTRY_TYPE.COMMIT
  | typeof PACK_ENTRY_TYPE.TREE
  | typeof PACK_ENTRY_TYPE.BLOB
  | typeof PACK_ENTRY_TYPE.TAG => {
  switch (type) {
    case 'commit':
      return PACK_ENTRY_TYPE.COMMIT;
    case 'tree':
      return PACK_ENTRY_TYPE.TREE;
    case 'blob':
      return PACK_ENTRY_TYPE.BLOB;
    case 'tag':
      return PACK_ENTRY_TYPE.TAG;
  }
};

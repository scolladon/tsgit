/**
 * Packfile assembler. `buildPack` produces a v2 packfile containing every
 * given oid, either as a base entry (type 1-4) or — when the caller opts
 * in via `delta: true` — as an `OFS_DELTA` entry against an earlier entry
 * in the same pack. Each base entry's content is the canonical loose-format
 * body (the bytes hashed to produce the oid) `deflate`d via the active
 * `ctx.compressor`. The pack trailer is the SHA over the body.
 *
 * The receiver (`git-receive-pack`) accepts the resulting pack because it
 * is self-contained: no REF_DELTA references and no thin-pack assumption —
 * every delta's base precedes it in the same pack.
 */
import { bytesToHex } from '../../domain/objects/encoding.js';
import { type GitObject, type ObjectId, serializeObject } from '../../domain/objects/index.js';
import { resolveDeltaPolicy } from '../../domain/storage/delta-policy.js';
import {
  objectTypeToPackEntryType,
  type PackIndexWriterEntry,
  type PackWriterBaseEntry,
  type PackWriterEntry,
  serializePackfile,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { deltifyEntries } from './internal/deltify.js';
import { readObject } from './read-object.js';

export interface BuildPackInput {
  readonly oids: ReadonlyArray<ObjectId>;
  /** Emit OFS_DELTA entries where a delta is strictly smaller on disk. Default false. */
  readonly delta?: boolean;
}

export interface BuildPackResult {
  readonly bytes: Uint8Array;
  /** Hex SHA of the pack body, also the trailer (last 20 bytes). */
  readonly sha: string;
  readonly objectCount: number;
  /** One `{ id, crc32, offset }` triple per object, in EMISSION order. Each
   *  meta carries its own identity, so a caller keys on `id` and can never
   *  pair a checksum with the wrong object. */
  readonly entries: ReadonlyArray<PackIndexWriterEntry>;
}

interface WriterPlan {
  readonly ids: ReadonlyArray<ObjectId>;
  readonly entries: ReadonlyArray<PackWriterEntry>;
}

export const buildPack = async (ctx: Context, input: BuildPackInput): Promise<BuildPackResult> => {
  const plan = await resolveWriterPlan(ctx, input);
  const packfile = serializePackfile(plan.entries);
  const trailerBytes = await ctx.hash.hash(packfile.data);
  const sha = bytesToHex(trailerBytes);
  const bytes = new Uint8Array(packfile.data.length + trailerBytes.length);
  bytes.set(packfile.data, 0);
  bytes.set(trailerBytes, packfile.data.length);
  const entries = plan.ids.map((id, i) => ({ id, ...packfile.entries[i]! }));
  return { bytes, sha, objectCount: plan.entries.length, entries };
};

/**
 * Chooses the base-only or delta-selecting path. `readConfig` is memoised
 * per session, so reading it once here — rather than mid-pass — means a
 * concurrent config write cannot change the policy partway through one
 * pack build.
 */
async function resolveWriterPlan(ctx: Context, input: BuildPackInput): Promise<WriterPlan> {
  if (input.delta !== true) return buildBaseEntries(ctx, input.oids);
  const config = await readConfig(ctx);
  const policy = resolveDeltaPolicy(config.pack ?? {});
  if (!policy.enabled) return buildBaseEntries(ctx, input.oids);
  const deltified = await deltifyEntries(ctx, input.oids, policy);
  return { ids: deltified.map((d) => d.id), entries: deltified.map((d) => d.entry) };
}

async function buildBaseEntries(ctx: Context, oids: ReadonlyArray<ObjectId>): Promise<WriterPlan> {
  const entries: PackWriterBaseEntry[] = [];
  for (const oid of oids) {
    const object = await readObject(ctx, oid);
    entries.push(await encodeEntry(ctx, object));
  }
  return { ids: oids, entries };
}

const encodeEntry = async (ctx: Context, object: GitObject): Promise<PackWriterBaseEntry> => {
  const loose = serializeObject(object, ctx.hashConfig);
  const nul = loose.indexOf(0);
  // loose came from our own serializeObject which always writes
  // `<type> <size>\0...`, so `nul` is always > 0 by construction.
  const content = loose.subarray(nul + 1);
  const compressedData = await ctx.compressor.deflate(content);
  return {
    type: objectTypeToPackEntryType(object.type),
    uncompressedSize: content.length,
    compressedData,
  };
};

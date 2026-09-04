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
import { bytesToHex, hexToBytes } from '../../domain/objects/encoding.js';
import { type GitObject, type ObjectId, serializeObject } from '../../domain/objects/index.js';
import { resolveDeltaPolicy } from '../../domain/storage/delta-policy.js';
import {
  objectTypeToPackEntryType,
  type PackIndexEntries,
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
  /** The pack's oid/crc32/offset slab, in EMISSION order — the native
   *  `PackIndexEntries` shape every `.idx`/`.rev`/cruft serializer consumes
   *  directly, with no intermediate hex-bearing array on the write path. */
  readonly entries: PackIndexEntries;
  /** Emission ordinal -> index into the `oids` this build was given. The packer
   *  emits in its own (type, size, oid) order, so a caller holding per-object
   *  data keyed by ITS order — `gc`'s cruft mtimes are the case — maps across
   *  with this instead of decoding an oid per object. Four bytes an entry
   *  against the hex-bearing array this shape exists to avoid. */
  readonly emissionOrder: Uint32Array;
}

interface WriterPlan {
  readonly ids: ReadonlyArray<ObjectId>;
  readonly entries: ReadonlyArray<PackWriterEntry>;
  /** Emission ordinal -> index into `input.oids`. */
  readonly emissionOrder: Uint32Array;
}

export const buildPack = async (ctx: Context, input: BuildPackInput): Promise<BuildPackResult> => {
  const plan = await resolveWriterPlan(ctx, input);
  const packfile = serializePackfile(plan.entries);
  const trailerBytes = await ctx.hash.hash(packfile.data);
  const sha = bytesToHex(trailerBytes);
  const bytes = new Uint8Array(packfile.data.length + trailerBytes.length);
  bytes.set(packfile.data, 0);
  bytes.set(trailerBytes, packfile.data.length);

  const digestLength = ctx.hash.digestLength;
  const count = plan.ids.length;
  const oids = new Uint8Array(count * digestLength);
  const crcValues = new Uint32Array(count);
  const offsets = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    oids.set(hexToBytes(plan.ids[i]!), i * digestLength);
    const meta = packfile.entries[i]!;
    crcValues[i] = meta.crc32;
    offsets[i] = meta.offset;
  }
  const entries: PackIndexEntries = { count, digestLength, oids, crcValues, offsets };

  return {
    bytes,
    sha,
    objectCount: plan.entries.length,
    entries,
    emissionOrder: plan.emissionOrder,
  };
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
  const emissionOrder = new Uint32Array(deltified.length);
  for (let i = 0; i < deltified.length; i += 1) emissionOrder[i] = deltified[i]!.sourceIndex;
  return {
    ids: deltified.map((d) => d.id),
    entries: deltified.map((d) => d.entry),
    emissionOrder,
  };
}

async function buildBaseEntries(ctx: Context, oids: ReadonlyArray<ObjectId>): Promise<WriterPlan> {
  const entries: PackWriterBaseEntry[] = [];
  for (const oid of oids) {
    const object = await readObject(ctx, oid);
    entries.push(await encodeEntry(ctx, object));
  }
  // The base-only route emits in input order, so the permutation is identity.
  const emissionOrder = new Uint32Array(oids.length);
  // Stryker disable next-line EqualityOperator: equivalent — `emissionOrder`
  // is a fixed-length `Uint32Array(oids.length)`; an extra `i === oids.length`
  // iteration writes `emissionOrder[oids.length]`, out of bounds, which typed
  // arrays silently no-op rather than throw or grow, so `<= oids.length` is
  // observationally identical to `< oids.length`.
  for (let i = 0; i < oids.length; i += 1) emissionOrder[i] = i;
  return { ids: oids, entries, emissionOrder };
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

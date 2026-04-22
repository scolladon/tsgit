/**
 * Synthetic packfile builder for object-resolver / pack-registry tests.
 *
 * Supports:
 *   - Base entries (blob/tree/commit/tag) written directly
 *   - OFS_DELTA entries referencing a previous entry by negative-offset distance
 *   - REF_DELTA entries referencing a base by SHA
 *
 * The delta instruction encoder produces the simplest viable delta: a single
 * COPY instruction that duplicates the base verbatim, plus an INSERT tail when
 * the caller wants the reconstructed target to differ from the base.
 */

import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { crc32 } from '../../../../src/domain/storage/crc32.js';
import {
  encodeOfsDistance,
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  type PackEntryType,
  serializePackHeader,
} from '../../../../src/domain/storage/pack-entry.js';
import { serializePackIndex } from '../../../../src/domain/storage/pack-writer.js';
import type { Context } from '../../../../src/ports/context.js';

export interface BaseEntrySpec {
  readonly kind: 'base';
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Raw object content (without the `<type> <size>\0` header). */
  readonly content: Uint8Array;
}

export interface OfsDeltaSpec {
  readonly kind: 'ofs-delta';
  /** Index of the base entry in the `entries` array (must be earlier). */
  readonly baseIndex: number;
  /**
   * Target content the delta should reconstruct. The fixture encodes a delta
   * that produces exactly these bytes; the base content is read from the base
   * entry at `baseIndex`.
   */
  readonly targetContent: Uint8Array;
}

export interface RefDeltaSpec {
  readonly kind: 'ref-delta';
  /** ObjectId (40-hex) of the base — must be already present somewhere. */
  readonly baseId: string;
  /** Uncompressed base content (needed to declare sourceLength in the delta). */
  readonly baseUncompressed: Uint8Array;
  readonly targetContent: Uint8Array;
}

export type EntrySpec = BaseEntrySpec | OfsDeltaSpec | RefDeltaSpec;

export interface PackBuildResult {
  readonly packBytes: Uint8Array;
  readonly idxBytes: Uint8Array;
  /** Target content + id for each entry (deltas report their reconstructed target). */
  readonly ids: ReadonlyArray<string>;
}

export async function buildSyntheticPack(
  ctx: Context,
  entries: ReadonlyArray<EntrySpec>,
): Promise<PackBuildResult> {
  const header = serializePackHeader(2, entries.length);
  const chunks: Uint8Array[] = [header];
  const offsets: number[] = [];
  const ids: string[] = [];
  const crc32Values: number[] = [];

  let currentOffset = header.length;
  const uncompressedByIndex: Uint8Array[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const spec = entries[i]!;
    let uncompressed: Uint8Array;
    let entryBytes: Uint8Array;

    if (spec.kind === 'base') {
      uncompressed = spec.content;
      const compressed = await ctx.compressor.deflate(uncompressed);
      const packType = typeNameToPackType(spec.type);
      const typeHeader = encodePackEntryHeader(packType, uncompressed.length);
      entryBytes = concat(typeHeader, compressed);
    } else if (spec.kind === 'ofs-delta') {
      const base = uncompressedByIndex[spec.baseIndex];
      if (base === undefined) {
        throw new Error(`base entry ${spec.baseIndex} must precede delta`);
      }
      const delta = encodeDeltaFromScratch(base, spec.targetContent);
      uncompressed = spec.targetContent;
      const compressed = await ctx.compressor.deflate(delta);
      const typeHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, delta.length);
      const baseOffset = offsets[spec.baseIndex]!;
      const distance = currentOffset - baseOffset;
      const ofsBytes = encodeOfsDistance(distance);
      entryBytes = concat(typeHeader, ofsBytes, compressed);
    } else {
      const delta = encodeDeltaFromScratch(spec.baseUncompressed, spec.targetContent);
      uncompressed = spec.targetContent;
      const compressed = await ctx.compressor.deflate(delta);
      const typeHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.REF_DELTA, delta.length);
      const baseIdBytes = hexToBytes(spec.baseId);
      entryBytes = concat(typeHeader, baseIdBytes, compressed);
    }

    offsets.push(currentOffset);
    uncompressedByIndex[i] = uncompressed;
    chunks.push(entryBytes);
    crc32Values.push(crc32(entryBytes));
    currentOffset += entryBytes.length;

    // Compute the id of the reconstructed object (same id space whether loose
    // or delta-resolved). The id is over `<type> <size>\0<content>`.
    const resolvedType = resolvedTypeOf(entries, i);
    const fullBytes = prependObjectHeader(uncompressed, resolvedType);
    const id = await ctx.hash.hashHex(fullBytes);
    ids.push(id);
  }

  const packWithoutChecksum = concatAll(chunks);
  const packChecksumHex = await ctx.hash.hashHex(packWithoutChecksum);
  const packChecksum = hexToBytes(packChecksumHex);
  const packBytes = concat(packWithoutChecksum, packChecksum);

  const idxEntries = ids.map((id, i) => ({
    id,
    crc32: crc32Values[i]!,
    offset: offsets[i]!,
  }));
  const idxFromWriter = serializePackIndex(idxEntries, packChecksum);
  // parsePackIndex expects a 40-byte trailer (pack-checksum + idx-checksum) but
  // serializePackIndex currently emits only 20. Pad the idx with a computed
  // idx-checksum so the parser accepts the file.
  const idxChecksumHex = await ctx.hash.hashHex(idxFromWriter);
  const idxBytes = concat(idxFromWriter, hexToBytes(idxChecksumHex));

  return { packBytes, idxBytes, ids };
}

/**
 * Write a synthetic pack to `ctx`'s memory fs under `.git/objects/pack/pack-<name>.pack`
 * and `.idx`. Returns the ids of each entry.
 */
export async function writeSyntheticPack(
  ctx: Context,
  name: string,
  entries: ReadonlyArray<EntrySpec>,
): Promise<ReadonlyArray<string>> {
  const result = await buildSyntheticPack(ctx, entries);
  const base = `${ctx.config.gitDir}/objects/pack/pack-${name}`;
  await ctx.fs.write(`${base}.pack`, result.packBytes);
  await ctx.fs.write(`${base}.idx`, result.idxBytes);
  return result.ids;
}

/* ──────────────── helpers ──────────────── */

function typeNameToPackType(name: BaseEntrySpec['type']): PackEntryType {
  switch (name) {
    case 'commit':
      return PACK_ENTRY_TYPE.COMMIT;
    case 'tree':
      return PACK_ENTRY_TYPE.TREE;
    case 'blob':
      return PACK_ENTRY_TYPE.BLOB;
    case 'tag':
      return PACK_ENTRY_TYPE.TAG;
  }
}

function resolvedTypeOf(entries: ReadonlyArray<EntrySpec>, index: number): BaseEntrySpec['type'] {
  const spec = entries[index]!;
  if (spec.kind === 'base') return spec.type;
  if (spec.kind === 'ofs-delta') return resolvedTypeOf(entries, spec.baseIndex);
  // REF_DELTA: assume caller provided a blob (test fixture convention).
  return 'blob';
}

function prependObjectHeader(content: Uint8Array, type: string): Uint8Array {
  const headerStr = `${type} ${content.length}\0`;
  const headerBytes = new TextEncoder().encode(headerStr);
  const out = new Uint8Array(headerBytes.length + content.length);
  out.set(headerBytes, 0);
  out.set(content, headerBytes.length);
  return out;
}

/**
 * Encode a git delta that reconstructs `target` without referencing `base`.
 * We use INSERT instructions only, so the base content doesn't matter for
 * correctness — only its declared sourceLength. This is sufficient to exercise
 * the delta resolution pipeline; applyDelta validates sourceLength and targetLength.
 */
function encodeDeltaFromScratch(base: Uint8Array, target: Uint8Array): Uint8Array {
  const parts: number[] = [];
  encodeVarint(parts, base.length); // sourceLength
  encodeVarint(parts, target.length); // targetLength
  // INSERT in chunks of at most 127 bytes.
  let offset = 0;
  while (offset < target.length) {
    const chunk = Math.min(127, target.length - offset);
    parts.push(chunk); // INSERT opcode: high bit clear, value = chunk size
    for (let i = 0; i < chunk; i += 1) {
      parts.push(target[offset + i]!);
    }
    offset += chunk;
  }
  return new Uint8Array(parts);
}

function encodeVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
}

function concat(...arrays: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function concatAll(arrays: ReadonlyArray<Uint8Array>): Uint8Array {
  return concat(...arrays);
}

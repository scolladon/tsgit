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
import { parsePackIndex } from '../../../../src/domain/storage/pack-index.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import { serializePackIndex } from '../../../../src/domain/storage/pack-writer.js';
import { REV_HEADER_SIZE } from '../../../../src/domain/storage/rev-index.js';
import type { Context } from '../../../../src/ports/context.js';
import { packIndexEntriesOf } from '../../../fixtures/storage/pack-index-entries.js';

export interface BaseEntrySpec {
  readonly kind: 'base';
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Raw object content (without the `<type> <size>\0` header). */
  readonly content: Uint8Array;
  /**
   * Index this entry under a caller-chosen id instead of the content's real
   * hash — the only way to plant a packed object whose bytes don't hash to
   * its indexed id (hash-mismatch fixtures for fsck-style tests).
   */
  readonly idOverride?: string;
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
  /**
   * Encode this exact byte distance instead of the entry's real offset delta
   * — the only way to plant an OFS_DELTA whose declared base distance sends
   * the walker before the pack body (negative-offset degrade fixtures). The
   * index and content still resolve normally; only the on-disk distance lies.
   */
  readonly distanceOverride?: number;
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
  /** Each entry's start offset within `packBytes` — lets a caller derive a
   * `distanceOverride` relative to an entry's own real position. */
  readonly offsets: ReadonlyArray<number>;
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
      const distance = spec.distanceOverride ?? currentOffset - baseOffset;
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
    const realId = await ctx.hash.hashHex(fullBytes);
    const id = spec.kind === 'base' ? (spec.idOverride ?? realId) : realId;
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
  const idxFromWriter = serializePackIndex(
    sortPackIndexEntries(packIndexEntriesOf(idxEntries, packChecksum.length)),
    packChecksum,
  );
  // parsePackIndex expects a 40-byte trailer (pack-checksum + idx-checksum) but
  // serializePackIndex currently emits only 20. Pad the idx with a computed
  // idx-checksum so the parser accepts the file.
  const idxChecksumHex = await ctx.hash.hashHex(idxFromWriter);
  const idxBytes = concat(idxFromWriter, hexToBytes(idxChecksumHex));

  return { packBytes, idxBytes, ids, offsets };
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
  const base = `${ctx.layout.gitDir}/objects/pack/pack-${name}`;
  await ctx.fs.write(`${base}.pack`, result.packBytes);
  await ctx.fs.write(`${base}.idx`, result.idxBytes);
  return result.ids;
}

/**
 * Overwrites the `.idx` small-offsets-table slot currently holding
 * `targetOffset` with `corruptedOffset`, leaving every other byte — including
 * the `.pack` file itself — untouched. Plants a `.idx` whose declared
 * successor for some OTHER entry lies past the pack's real end, the shape a
 * fetched or cloned pack's attacker-controlled `.idx` can carry (`readOffset`
 * bounds an offset's own encoding but never the pack's actual size). No
 * table-row order assumption: the small-offsets table is scanned for the
 * exact value, not indexed by the entry's position among the (oid-sorted)
 * sha table.
 */
export function corruptIdxOffset(
  idxBytes: Uint8Array,
  digestLength: 20 | 32,
  targetOffset: number,
  corruptedOffset: number,
): Uint8Array {
  const mutated = idxBytes.slice();
  const index = parsePackIndex(mutated, digestLength);
  const view = new DataView(mutated.buffer, mutated.byteOffset, mutated.byteLength);
  for (let position = 0; position < index.objectCount; position += 1) {
    const slot = index.smallOffsetsTableOffset + position * 4;
    if (view.getUint32(slot) === targetOffset) {
      view.setUint32(slot, corruptedOffset);
      return mutated;
    }
  }
  throw new Error(`offset ${targetOffset} not present in idx small-offsets table`);
}

export interface PackHeaderOverride {
  readonly magic?: number;
  readonly version?: number;
  readonly objectCount?: number;
}

/**
 * Rewrite a written pack's 12-byte header in place and re-stamp its trailer over
 * `bytes[0 .. len − digestLength)`, so the only thing wrong with the pack is what
 * the caller asked for.
 */
export async function restampPackHeader(
  ctx: Context,
  packPath: string,
  override: PackHeaderOverride,
): Promise<void> {
  const bytes = await ctx.fs.read(packPath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (override.magic !== undefined) {
    view.setUint32(0, override.magic);
  }
  if (override.version !== undefined) {
    view.setUint32(4, override.version);
  }
  if (override.objectCount !== undefined) {
    view.setUint32(8, override.objectCount);
  }
  const digestLength = ctx.hashConfig.digestLength;
  const checksumHex = await ctx.hash.hashHex(bytes.subarray(0, bytes.length - digestLength));
  bytes.set(hexToBytes(checksumHex), bytes.length - digestLength);
  await ctx.fs.write(packPath, bytes);
}

const REV_MAGIC = 0x52494458; // 'RIDX'

export interface RevIndexOverride {
  readonly magic?: number;
  readonly version?: number;
  readonly hashId?: number;
  /** Embedded pack-checksum copy — never verified by the reader, so any
   *  value round-trips; the trailer below is always recomputed to match
   *  whatever body/header/packChecksum bytes actually precede it. */
  readonly packChecksum?: Uint8Array;
  /** Truncate the fully-built file to this many bytes — corrupts the
   *  trailer along with everything past the cut, deliberately: the trailer
   *  is recomputed BEFORE truncation, so a cut always leaves it wrong too. */
  readonly truncateTo?: number;
  readonly appendBytes?: number;
  /** Flip one trailer byte after the real digest is computed — the ONLY
   *  way to plant a structurally well-formed `.rev` whose checksum disagrees
   *  with its own content. */
  readonly flipChecksum?: boolean;
}

/**
 * Write a synthetic pack reverse index (`pack-<name>.rev`) to `ctx`'s memory
 * fs. `body` is the index-position-per-pack-position array the file stores
 * — the caller supplies it correct (a healthy fixture) or deliberately wrong
 * at chosen positions (a corruption fixture); this writer never derives or
 * validates it. The trailer is always a real digest over the preceding
 * bytes, computed with `ctx.hash` — so a fixture is only ever wrong in the
 * one dimension its `opts` name.
 */
export async function writeSyntheticRevIndex(
  ctx: Context,
  packName: string,
  body: ArrayLike<number>,
  opts: RevIndexOverride = {},
): Promise<void> {
  const digestLength = ctx.hashConfig.digestLength;
  const bodySize = body.length * 4;
  const bytes = new Uint8Array(REV_HEADER_SIZE + bodySize + digestLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, opts.magic ?? REV_MAGIC);
  view.setUint32(4, opts.version ?? 1);
  view.setUint32(8, opts.hashId ?? (digestLength === 32 ? 2 : 1));
  for (let i = 0; i < body.length; i += 1) {
    view.setUint32(REV_HEADER_SIZE + i * 4, body[i]!);
  }
  const packChecksum = opts.packChecksum ?? new Uint8Array(digestLength).fill(0xaa);
  bytes.set(packChecksum, REV_HEADER_SIZE + bodySize);

  const checksumHex = await ctx.hash.hashHex(bytes);
  const trailer = hexToBytes(checksumHex);
  if (opts.flipChecksum === true) trailer[0] = trailer[0]! ^ 0xff;

  let out = concat(bytes, trailer);
  if (opts.truncateTo !== undefined) out = out.slice(0, opts.truncateTo);
  if (opts.appendBytes !== undefined) out = concat(out, new Uint8Array(opts.appendBytes));

  const path = `${ctx.layout.gitDir}/objects/pack/pack-${packName}.rev`;
  await ctx.fs.write(path, out);
}

export interface SyntheticBitmapOverride {
  /**
   * Body to compute the trailing digest over, when it differs from `body`
   * itself — the only way to plant a bitmap whose trailer is STALE: correct
   * for a body the caller has since corrupted, wrong for the bytes actually
   * on disk. Defaults to `body` — a RESTAMPED trailer, correct for whatever
   * bytes are actually written, however structurally corrupt.
   */
  readonly digestOver?: Uint8Array;
  /** Flip one trailer byte after the digest (real or stale) is computed —
   *  the only way to plant a bitmap whose trailer disagrees with EVERY
   *  body, corrupted or not. */
  readonly flipTrailer?: boolean;
  /** Truncate the fully-assembled bytes (`body` + trailer) to this length —
   *  corrupts the trailer along with everything past the cut, deliberately. */
  readonly truncateTo?: number;
}

/**
 * Writes a synthetic pack or multi-pack-index bitmap (`<name>.bitmap`) to
 * `ctx`'s memory fs: `body` — arbitrary bytes this writer never inspects or
 * validates, the caller's own structural shape or corruption of it — plus a
 * trailing digest. `writeSyntheticBitmap` is the only thing this fixture
 * gets to be wrong about: the digest, real (default) or stale
 * (`digestOver`), flipped (`flipTrailer`) or truncated away (`truncateTo`).
 */
export async function writeSyntheticBitmap(
  ctx: Context,
  path: string,
  body: Uint8Array,
  opts: SyntheticBitmapOverride = {},
): Promise<void> {
  const checksumHex = await ctx.hash.hashHex(opts.digestOver ?? body);
  const trailer = hexToBytes(checksumHex);
  if (opts.flipTrailer === true) trailer[0] = trailer[0]! ^ 0xff;

  let out = concat(body, trailer);
  if (opts.truncateTo !== undefined) out = out.slice(0, opts.truncateTo);

  await ctx.fs.write(path, out);
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

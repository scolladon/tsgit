import { decode, hexToBytes } from '../objects/encoding.js';
import { ObjectId } from '../objects/index.js';
import { invalidCommitGraphChunk, invalidCommitGraphHeader } from './error.js';

const MAGIC = 'CGPH';
const SUPPORTED_VERSION = 1;
const HEADER_SIZE = 8;
const CHUNK_TABLE_ROW_SIZE = 12;
const FANOUT_ENTRIES = 256;
const FANOUT_SIZE = FANOUT_ENTRIES * 4;
const CDAT_FIXED_SIZE = 16; // parent1(4) + parent2(4) + generation/date(8)

const CHUNK_ID_OIDF = 'OIDF';
const CHUNK_ID_OIDL = 'OIDL';
const CHUNK_ID_CDAT = 'CDAT';
const CHUNK_ID_GDA2 = 'GDA2';
const CHUNK_ID_GDO2 = 'GDO2';
const CHUNK_ID_EDGE = 'EDGE';
const CHUNK_ID_BASE = 'BASE';

/** Bytes per GDO2 entry: a plain (non-flagged) 64-bit corrected-date offset. */
const GDO2_ENTRY_SIZE = 8;

/** CDAT parent-position sentinel: this parent slot is unused. */
export const NO_PARENT = 0x70000000;
/** CDAT parent2-position flag: the low 31 bits index into the EDGE chunk (octopus merge). */
export const OCTOPUS_FLAG = 0x80000000;
/** EDGE entry flag: this is the last parent position in the commit's chain. */
export const EDGE_LAST_FLAG = 0x80000000;
/** Mask isolating the position bits of an EDGE entry, an octopus CDAT parent2 slot, or a GDA2 overflow entry's GDO2 index. */
export const EDGE_POS_MASK = 0x7fffffff;
/** GDA2 entry flag: the low 31 bits index into the GDO2 overflow chunk. */
export const GENERATION_OVERFLOW_FLAG = 0x80000000;

interface ChunkRange {
  readonly start: number;
  readonly end: number;
}

export interface CommitData {
  readonly rootTree: ObjectId;
  readonly parent1Pos: number | undefined;
  readonly parent2Pos: number | undefined;
  readonly additionalParentPositions: readonly number[];
  readonly generation: number;
  readonly committerDate: number;
}

/** A single parsed `commit-graph` file — either the standalone file or one chain layer. */
export interface CommitGraphLayer {
  readonly hashVersion: 1 | 2;
  readonly numBaseGraphs: number;
  readonly baseGraphHashes: readonly ObjectId[];
  readonly commitCount: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
  readonly _hashLength: number;
  readonly _fanoutOffset: number;
  readonly _oidLookupOffset: number;
  readonly _commitDataOffset: number;
  readonly _commitDataEntrySize: number;
  readonly _generationDataRange: ChunkRange | undefined;
  readonly _extraEdgeRange: ChunkRange | undefined;
  readonly _overflowGenerationRange: ChunkRange | undefined;
}

export function parseCommitGraphLayer(bytes: Uint8Array): CommitGraphLayer {
  if (bytes.length < HEADER_SIZE) {
    throw invalidCommitGraphHeader('truncated: file too short for header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) {
    throw invalidCommitGraphHeader(`invalid magic: expected ${MAGIC}, got ${magic}`);
  }

  const version = view.getUint8(4);
  if (version !== SUPPORTED_VERSION) {
    throw invalidCommitGraphHeader(`unsupported version: expected 1, got ${version}`);
  }

  const hashVersion = view.getUint8(5);
  if (hashVersion !== 1 && hashVersion !== 2) {
    throw invalidCommitGraphHeader(`unsupported hash version: expected 1 or 2, got ${hashVersion}`);
  }

  const numChunks = view.getUint8(6);
  const numBaseGraphs = view.getUint8(7);
  const hashLength = hashVersion === 1 ? 20 : 32;

  const chunkRanges = readChunkTable(bytes, view, numChunks, hashLength);

  const oidf = requireChunk(chunkRanges, CHUNK_ID_OIDF);
  validateChunkSize(oidf, FANOUT_SIZE, CHUNK_ID_OIDF);
  const commitCount = view.getUint32(oidf.start + (FANOUT_ENTRIES - 1) * 4);

  const oidl = requireChunk(chunkRanges, CHUNK_ID_OIDL);
  validateChunkSize(oidl, commitCount * hashLength, CHUNK_ID_OIDL);

  const commitDataEntrySize = hashLength + CDAT_FIXED_SIZE;
  const cdat = requireChunk(chunkRanges, CHUNK_ID_CDAT);
  validateChunkSize(cdat, commitCount * commitDataEntrySize, CHUNK_ID_CDAT);

  const generationDataRange = chunkRanges.get(CHUNK_ID_GDA2);
  if (generationDataRange !== undefined) {
    validateChunkSize(generationDataRange, commitCount * 4, CHUNK_ID_GDA2);
  }

  const extraEdgeRange = chunkRanges.get(CHUNK_ID_EDGE);
  const overflowGenerationRange = chunkRanges.get(CHUNK_ID_GDO2);

  const baseGraphHashes = readBaseGraphHashes(chunkRanges, numBaseGraphs, hashLength, bytes);

  return {
    hashVersion: hashVersion as 1 | 2,
    numBaseGraphs,
    baseGraphHashes,
    commitCount,
    _bytes: bytes,
    _view: view,
    _hashLength: hashLength,
    _fanoutOffset: oidf.start,
    _oidLookupOffset: oidl.start,
    _commitDataOffset: cdat.start,
    _commitDataEntrySize: commitDataEntrySize,
    _generationDataRange: generationDataRange,
    _extraEdgeRange: extraEdgeRange,
    _overflowGenerationRange: overflowGenerationRange,
  };
}

function readChunkTable(
  bytes: Uint8Array,
  view: DataView,
  numChunks: number,
  hashLength: number,
): ReadonlyMap<string, ChunkRange> {
  const rowCount = numChunks + 1;
  const tableEnd = HEADER_SIZE + rowCount * CHUNK_TABLE_ROW_SIZE;
  if (bytes.length < tableEnd) {
    throw invalidCommitGraphChunk('truncated: chunk table extends past end of file');
  }

  const rows: { readonly id: string; readonly offset: number }[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const rowStart = HEADER_SIZE + i * CHUNK_TABLE_ROW_SIZE;
    const id = decode(bytes.subarray(rowStart, rowStart + 4));
    rows.push({ id, offset: readUint64BE(view, rowStart + 4) });
  }

  const trailerStart = rows[rows.length - 1]!.offset;
  if (bytes.length < trailerStart + hashLength) {
    throw invalidCommitGraphChunk('truncated: file ends before trailer');
  }

  const ranges = new Map<string, ChunkRange>();
  for (let i = 0; i < numChunks; i += 1) {
    ranges.set(rows[i]!.id, { start: rows[i]!.offset, end: rows[i + 1]!.offset });
  }
  return ranges;
}

/** Reads a big-endian 64-bit unsigned integer as a JS number — every value
 *  this format stores in 64 bits (chunk-table offsets, GDO2 entries) stays
 *  far below `Number.MAX_SAFE_INTEGER`, so plain arithmetic is exact. */
function readUint64BE(view: DataView, offset: number): number {
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 0x100000000 + low;
}

function requireChunk(ranges: ReadonlyMap<string, ChunkRange>, id: string): ChunkRange {
  const range = ranges.get(id);
  if (range === undefined) {
    throw invalidCommitGraphChunk(`missing required ${id} chunk`);
  }
  return range;
}

function validateChunkSize(range: ChunkRange, expectedSize: number, id: string): void {
  const actualSize = range.end - range.start;
  if (actualSize !== expectedSize) {
    throw invalidCommitGraphChunk(
      `truncated ${id} chunk: expected ${expectedSize} bytes, got ${actualSize}`,
    );
  }
}

function readBaseGraphHashes(
  ranges: ReadonlyMap<string, ChunkRange>,
  numBaseGraphs: number,
  hashLength: number,
  bytes: Uint8Array,
): readonly ObjectId[] {
  const base = ranges.get(CHUNK_ID_BASE);
  if (base === undefined) {
    if (numBaseGraphs !== 0) {
      throw invalidCommitGraphChunk(
        `missing BASE chunk: header declares ${numBaseGraphs} base graphs`,
      );
    }
    return [];
  }

  validateChunkSize(base, numBaseGraphs * hashLength, CHUNK_ID_BASE);

  const hashes: ObjectId[] = [];
  for (let i = 0; i < numBaseGraphs; i += 1) {
    const offset = base.start + i * hashLength;
    hashes.push(ObjectId.fromRaw(bytes.subarray(offset, offset + hashLength)));
  }
  return hashes;
}

/** Binary search for `oid` within the layer's fanout-backed OIDL chunk. */
export function positionOf(layer: CommitGraphLayer, oid: ObjectId): number | undefined {
  const targetBytes = hexToBytes(oid);
  const firstByte = targetBytes[0]!;
  const high = layer._view.getUint32(layer._fanoutOffset + firstByte * 4);

  let low = 0;
  let hi = high;
  while (low < hi) {
    const mid = (low + hi) >>> 1;
    const cmp = compareOidAt(layer, mid, targetBytes);
    if (cmp < 0) {
      low = mid + 1;
    } else if (cmp > 0) {
      hi = mid;
    } else {
      return mid;
    }
  }
  return undefined;
}

function compareOidAt(layer: CommitGraphLayer, index: number, targetBytes: Uint8Array): number {
  const base = layer._oidLookupOffset + index * layer._hashLength;
  const bytes = layer._bytes;
  // Stryker disable next-line EqualityOperator: equivalent — an extra k===hashLength
  // iteration compares bytes[base+hashLength] (a real byte past this OID) against
  // targetBytes[hashLength] (undefined, since targetBytes.length===hashLength),
  // yielding NaN; positionOf's binary search treats NaN identically to 0 (both fail
  // `<0` and `>0`, landing in the same `return mid` branch), so no caller ever
  // observes the difference.
  for (let k = 0; k < layer._hashLength; k += 1) {
    const diff = bytes[base + k]! - targetBytes[k]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Reads root tree, parent positions, generation, and committer date for a layer-local position. */
export function commitDataAt(layer: CommitGraphLayer, localPos: number): CommitData {
  const entryOffset = layer._commitDataOffset + localPos * layer._commitDataEntrySize;
  const view = layer._view;
  const hashLength = layer._hashLength;

  const rootTree = ObjectId.fromRaw(layer._bytes.subarray(entryOffset, entryOffset + hashLength));

  const parent1Raw = view.getUint32(entryOffset + hashLength);
  const parent2Raw = view.getUint32(entryOffset + hashLength + 4);
  const genWord = view.getUint32(entryOffset + hashLength + 8);
  const dateWord = view.getUint32(entryOffset + hashLength + 12);

  const committerDate = (genWord & 0x3) * 0x100000000 + dateWord;
  const generationV1 = genWord >>> 2;

  const parent1Pos = parent1Raw === NO_PARENT ? undefined : parent1Raw;
  const { parent2Pos, additionalParentPositions } = resolveSecondParent(layer, parent2Raw);
  const generation = resolveGeneration(layer, localPos, generationV1, committerDate);

  return { rootTree, parent1Pos, parent2Pos, additionalParentPositions, generation, committerDate };
}

function resolveSecondParent(
  layer: CommitGraphLayer,
  parent2Raw: number,
): {
  readonly parent2Pos: number | undefined;
  readonly additionalParentPositions: readonly number[];
} {
  if (parent2Raw === NO_PARENT) {
    return { parent2Pos: undefined, additionalParentPositions: [] };
  }
  if ((parent2Raw & OCTOPUS_FLAG) === 0) {
    return { parent2Pos: parent2Raw, additionalParentPositions: [] };
  }
  const chain = readEdgeChain(layer, parent2Raw & EDGE_POS_MASK);
  return { parent2Pos: chain[0], additionalParentPositions: chain.slice(1) };
}

function readEdgeChain(layer: CommitGraphLayer, edgePos: number): number[] {
  if (layer._extraEdgeRange === undefined) {
    throw invalidCommitGraphChunk('octopus parent references missing EDGE chunk');
  }
  const { start, end } = layer._extraEdgeRange;
  const positions: number[] = [];
  let cursor = start + edgePos * 4;
  while (cursor < end) {
    const raw = layer._view.getUint32(cursor);
    positions.push(raw & EDGE_POS_MASK);
    cursor += 4;
    if ((raw & EDGE_LAST_FLAG) !== 0) return positions;
  }
  throw invalidCommitGraphChunk('truncated EDGE chunk: octopus parent list never terminates');
}

function resolveGeneration(
  layer: CommitGraphLayer,
  localPos: number,
  generationV1: number,
  committerDate: number,
): number {
  if (layer._generationDataRange === undefined) {
    return generationV1;
  }
  const raw = layer._view.getUint32(layer._generationDataRange.start + localPos * 4);
  if ((raw & GENERATION_OVERFLOW_FLAG) !== 0) {
    return committerDate + readOverflowOffset(layer, raw & EDGE_POS_MASK);
  }
  return committerDate + raw;
}

/** The true (64-bit) corrected-date offset for a GDA2 entry whose overflow
 *  bit is set — `index` is the low 31 bits of that entry, a position into
 *  GDO2's flat array of plain (non-flagged) offsets. */
function readOverflowOffset(layer: CommitGraphLayer, index: number): number {
  const range = layer._overflowGenerationRange;
  if (range === undefined) {
    throw invalidCommitGraphChunk('generation overflow flag set but missing GDO2 chunk');
  }
  const offset = range.start + index * GDO2_ENTRY_SIZE;
  if (offset + GDO2_ENTRY_SIZE > range.end) {
    throw invalidCommitGraphChunk(`GDO2 index ${index} out of range`);
  }
  return readUint64BE(layer._view, offset);
}

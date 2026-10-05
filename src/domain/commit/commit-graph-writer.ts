/**
 * Commit-graph writer. `serializeCommitGraph` emits the exact chunk set
 * `git commit-graph write --reachable` writes at default settings:
 * `OIDF`, `OIDL`, `CDAT`, `GDA2`, `GDO2` when any corrected-date
 * offset overflows GDA2's plain 31-bit field, and `EDGE` when any commit has
 * more than two parents — in that order (git's own chunk table order,
 * confirmed against real git) — then `BASE` last when the file is a split
 * layer over base layers. Changed-path Bloom filters, when given, add `BIDX`
 * and `BDAT` after `EDGE` and before `BASE`.
 *
 * The trailer's `hashLength` bytes are left zero — this function does not
 * hash; the caller fills them in place over the returned buffer, the same
 * split `serializePackRevIndex` uses for `.rev`.
 *
 * @writes
 *   surface: commitGraph
 *   kind:    byte-identical
 *   format:  commit-graph-v1
 */
import { compareBytes, encode, hexToBytes } from '../objects/encoding.js';
import type { HashConfig } from '../objects/hash-config.js';
import type { ObjectId } from '../objects/object-id.js';
import type { BloomFilterSettings } from './bloom-filter.js';
import {
  EDGE_LAST_FLAG,
  GENERATION_OVERFLOW_FLAG,
  NO_PARENT,
  OCTOPUS_FLAG,
} from './commit-graph.js';

const MAGIC = 'CGPH';
const VERSION = 1;
const HEADER_SIZE = 8;
const CHUNK_TABLE_ROW_SIZE = 12;
const FANOUT_ENTRIES = 256;
const FANOUT_SIZE = FANOUT_ENTRIES * 4;
const CDAT_FIXED_SIZE = 16;
const GDO2_ENTRY_SIZE = 8;
const BLOOM_INDEX_ENTRY_SIZE = 4;
const BLOOM_DATA_HEADER_SIZE = 12;
const EMPTY_FILTER = new Uint8Array(0);

/**
 * GDA2 stores the corrected-date offset as a plain (non-flagged) u32; past
 * this threshold git sets `GENERATION_OVERFLOW_FLAG` and appends the true
 * 64-bit offset to `GDO2` instead. There is no refusal here, because git
 * itself has none: it computes the same offset arithmetic unconditionally
 * and only the GDA2/GDO2 split changes shape.
 */
export const MAX_GENERATION_OFFSET = 0x7fffffff;

/** A commit's writer-facing shape — the fields `CDAT`/`GDA2` encode.
 *  `parents` is ordered: index 0 is the CDAT `parent1` slot. */
export interface CommitGraphWriterCommit {
  readonly id: ObjectId;
  readonly rootTree: ObjectId;
  readonly parents: readonly ObjectId[];
  readonly committerDate: number;
}

export function hashLengthFor(hashVersion: 1 | 2): number {
  return hashVersion === 1 ? 20 : 32;
}

export function setUint64BE(view: DataView, offset: number, value: number): void {
  const high = Math.floor(value / 0x100000000);
  const low = value % 0x100000000;
  view.setUint32(offset, high);
  view.setUint32(offset + 4, low);
}

export interface CommitGraphGeneration {
  readonly level: number;
  readonly correctedDate: number;
}

type Generation = CommitGraphGeneration;

/**
 * git's corrected-commit-date pass: `skipped` when the layer carries no GDA2
 * (`commitGraph.generationVersion` other than 2, or a split layer over a top
 * base without one) — no date walk runs and the dates computed for the other
 * passes are never written; `untrusted` when a layer of the chain lacks GDA2,
 * so git first parses every commit once more and the base serves topological
 * levels in place of dates; `trusted` otherwise.
 */
export type CorrectedDatePass = 'skipped' | 'trusted' | 'untrusted';

/** A base-layer commit a written layer's commits name as a parent. */
export interface CommitGraphBaseCommit {
  /** Its chain-global position: the layers below the base it lives in, plus its local index. */
  readonly position: number;
  readonly generation: CommitGraphGeneration;
}

/**
 * The layers a split layer is written over: their trailing hashes base-first
 * (the `BASE` chunk), their summed commit count (local positions start past
 * it), and every base commit the written commits name as a parent.
 */
export interface CommitGraphBase {
  readonly layerHashes: readonly ObjectId[];
  readonly commitCount: number;
  readonly commits: ReadonlyMap<ObjectId, CommitGraphBaseCommit>;
}

export const EMPTY_COMMIT_GRAPH_BASE: CommitGraphBase = {
  layerHashes: [],
  commitCount: 0,
  commits: new Map(),
};

/** The changed-path Bloom filters a graph carries in `BIDX`/`BDAT`. */
export interface CommitGraphChangedPaths {
  readonly settings: BloomFilterSettings;
  /** Each commit's filter; a commit without one gets a zero-length filter, as git writes one it never computed. */
  readonly filters: ReadonlyMap<ObjectId, Uint8Array>;
}

interface ChunkSpec {
  readonly id: string;
  readonly size: number;
}

interface EdgePlan {
  readonly entries: readonly number[];
  readonly startByCommit: ReadonlyMap<ObjectId, number>;
}

/** Every commit whose corrected-date offset overflows GDA2's 31-bit field,
 *  in the order GDA2 encounters them — the same append-in-position-order
 *  shape `EdgePlan` uses for EDGE. */
interface OverflowPlan {
  readonly entries: readonly number[];
  readonly indexByCommit: ReadonlyMap<ObjectId, number>;
}

export function serializeCommitGraph(
  commits: readonly CommitGraphWriterCommit[],
  hashConfig: HashConfig,
  base: CommitGraphBase = EMPTY_COMMIT_GRAPH_BASE,
  changedPaths?: CommitGraphChangedPaths,
  generations: ReadonlyMap<ObjectId, Generation> = silentGenerations(commits, base),
  correctedDates: CorrectedDatePass = 'trusted',
): Uint8Array {
  const generationData = correctedDates !== 'skipped';
  const hashVersion: 1 | 2 = hashConfig.digestLength === 32 ? 2 : 1;
  const hashLength = hashLengthFor(hashVersion);
  const sortedCommits = sortByOid(commits);
  const positionOf = new Map([
    ...[...base.commits].map(([id, entry]) => [id, entry.position] as const),
    ...sortedCommits.map((commit, i) => [commit.id, base.commitCount + i] as const),
  ]);
  const overflowPlan = generationData
    ? planOverflowGenerations(sortedCommits, generations)
    : NO_OVERFLOW;

  const edgePlan = planEdges(sortedCommits, positionOf);
  const chunkSpecs = planChunks(sortedCommits.length, hashLength, {
    generationData,
    overflowEntryCount: overflowPlan.entries.length,
    edgeEntryCount: edgePlan.entries.length,
    baseLayerCount: base.layerHashes.length,
    bloomDataSize: changedPaths && bloomDataSize(sortedCommits, changedPaths.filters),
  });
  const offsets = computeChunkOffsets(chunkSpecs);
  const trailerStart = offsets[offsets.length - 1]!;

  const bytes = new Uint8Array(trailerStart + hashLength);
  const view = new DataView(bytes.buffer);
  writeHeaderAndChunkTable(bytes, view, hashVersion, chunkSpecs, offsets, trailerStart);
  view.setUint8(7, base.layerHashes.length);

  const chunkOffset = (id: string): number =>
    offsets[chunkSpecs.findIndex((spec) => spec.id === id)]!;
  writeOidfAndOidl(
    bytes,
    view,
    sortedCommits,
    chunkOffset('OIDF'),
    chunkOffset('OIDL'),
    hashLength,
  );
  writeCommitData(
    bytes,
    view,
    sortedCommits,
    positionOf,
    generations,
    chunkOffset('CDAT'),
    hashLength + CDAT_FIXED_SIZE,
    hashLength,
    edgePlan,
  );
  if (generationData) {
    writeGenerationData(view, sortedCommits, generations, overflowPlan, chunkOffset('GDA2'));
  }
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — writeOverflowGenerationChunk's forEach never iterates over an empty array, so calling it unconditionally has no observable effect when overflowPlan.entries.length is 0.
  if (overflowPlan.entries.length > 0) {
    writeOverflowGenerationChunk(view, overflowPlan.entries, chunkOffset('GDO2'));
  }
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — writeEdgeChunk's forEach never iterates over an empty array, so calling it unconditionally has no observable effect when edgePlan.entries.length is 0.
  if (edgePlan.entries.length > 0) writeEdgeChunk(view, edgePlan.entries, chunkOffset('EDGE'));
  if (changedPaths) {
    writeBloomChunks(bytes, view, sortedCommits, changedPaths, chunkOffset);
  }
  base.layerHashes.forEach((hash, i) => {
    bytes.set(hexToBytes(hash), chunkOffset('BASE') + i * hashLength);
  });

  return bytes;
}

const NO_OVERFLOW: OverflowPlan = { entries: [], indexByCommit: new Map() };

/** GDA2's overflow flag carries an index into GDO2 — assigned in sorted
 *  (position) order, the same order `writeGenerationData` visits commits. */
function planOverflowGenerations(
  sortedCommits: readonly CommitGraphWriterCommit[],
  generations: ReadonlyMap<ObjectId, Generation>,
): OverflowPlan {
  const entries: number[] = [];
  const indexByCommit = new Map<ObjectId, number>();
  for (const commit of sortedCommits) {
    const offset = generations.get(commit.id)!.correctedDate - commit.committerDate;
    if (offset > MAX_GENERATION_OFFSET) {
      indexByCommit.set(commit.id, entries.length);
      entries.push(offset);
    }
  }
  return { entries, indexByCommit };
}

/** The generations of commits that all parse, nothing observing the walk. */
function silentGenerations(
  commits: readonly CommitGraphWriterCommit[],
  base: CommitGraphBase,
): ReadonlyMap<ObjectId, Generation> {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const order = sortByOid(commits).map((commit) => commit.id);
  return computeCommitGraphGenerations(order, base, {
    parse: () => {},
    parsed: (id) => byId.get(id),
  });
}

function sortByOid(
  commits: readonly CommitGraphWriterCommit[],
): readonly CommitGraphWriterCommit[] {
  return [...commits].sort((a, b) => compareBytes(hexToBytes(a.id), hexToBytes(b.id)));
}

/**
 * Where git's `compute_reachable_generation_numbers` touches a commit:
 * `parse` is each `repo_parse_commit` call (a failed parse is not remembered,
 * so every call is one more attempt), `parsed` the commit as already parsed,
 * `undefined` when it failed — a commit with no parents and no date.
 */
export interface GenerationWalkView {
  readonly parse: (id: ObjectId) => void;
  readonly parsed: (id: ObjectId) => CommitGraphWriterCommit | undefined;
}

/** git's `GENERATION_NUMBER_V1_MAX`: the topological level CDAT's 30 bits hold. */
const MAX_TOPOLOGICAL_LEVEL = 0x3fffffff;

type DeriveGeneration = (date: number, maxParentGeneration: number) => number;

/** git's `compute_generation_from_max`, version 1: one past the highest parent, capped. */
const deriveLevel: DeriveGeneration = (_, maxParent) =>
  Math.min(maxParent, MAX_TOPOLOGICAL_LEVEL - 1) + 1;

/** Version 2: the commit's own date when it is past every parent's, else one past the highest — a dateless commit counts as none. */
const deriveCorrectedDate: DeriveGeneration = (date, maxParent) =>
  date > 0 && date > maxParent ? date : maxParent + 1;

/**
 * git's two generation passes over the commits being written, in `order`:
 * topological levels, then corrected commit dates. Base-layer commits arrive
 * known. Each pass parses every commit in turn and, walking down from one
 * not yet known, parses each parent it looks at, every time it looks.
 */
export function computeCommitGraphGenerations(
  order: readonly ObjectId[],
  base: CommitGraphBase,
  view: GenerationWalkView,
  pass: CorrectedDatePass = 'trusted',
): ReadonlyMap<ObjectId, Generation> {
  const levels = walkGenerations(order, view, deriveLevel, {
    known: baseGenerations(base, 'level'),
  });
  // A skipped pass leaves nothing to write, so the level stands in for a date no chunk holds.
  const dates = pass === 'skipped' ? levels : walkCorrectedDates(order, base, view, pass);
  const generations = new Map<ObjectId, Generation>();
  for (const [id, level] of levels) generations.set(id, { level, correctedDate: dates.get(id)! });
  return generations;
}

const baseGenerations = (base: CommitGraphBase, field: keyof Generation): Map<ObjectId, number> =>
  new Map([...base.commits].map(([id, { generation }]) => [id, generation[field]]));

/** git's `compute_generation_numbers`: an untrusted chain parses every commit first and reads the base for levels. */
function walkCorrectedDates(
  order: readonly ObjectId[],
  base: CommitGraphBase,
  view: GenerationWalkView,
  pass: Exclude<CorrectedDatePass, 'skipped'>,
): ReadonlyMap<ObjectId, number> {
  if (pass === 'untrusted') for (const id of order) view.parse(id);
  const known = baseGenerations(base, pass === 'untrusted' ? 'level' : 'correctedDate');
  return walkGenerations(order, view, deriveCorrectedDate, { known });
}

/** One pass of git's `compute_reachable_generation_numbers`. */
function walkGenerations(
  order: readonly ObjectId[],
  view: GenerationWalkView,
  derive: DeriveGeneration,
  { known }: { readonly known: Map<ObjectId, number> },
): ReadonlyMap<ObjectId, number> {
  for (const id of order) {
    view.parse(id);
    if (!known.has(id)) settleFrom(id, view, derive, known);
  }
  return known;
}

/** git's inner loop: the first parent not yet known is stacked, and the commit revisited once it is. */
function settleFrom(
  start: ObjectId,
  view: GenerationWalkView,
  derive: DeriveGeneration,
  known: Map<ObjectId, number>,
): void {
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.at(-1)!;
    const commit = view.parsed(current);
    const pending = firstUnknownParent(commit?.parents ?? [], view, known);
    if (pending !== undefined) {
      stack.push(pending);
      continue;
    }
    const maxParent = Math.max(0, ...(commit?.parents ?? []).map((parent) => known.get(parent)!));
    known.set(current, derive(commit?.committerDate ?? 0, maxParent));
    stack.pop();
  }
}

function firstUnknownParent(
  parents: readonly ObjectId[],
  view: GenerationWalkView,
  known: ReadonlyMap<ObjectId, number>,
): ObjectId | undefined {
  for (const parent of parents) {
    view.parse(parent);
    if (!known.has(parent)) return parent;
  }
  return undefined;
}

/** Positions (index 1 onward) for every commit with >2 parents, chained into
 *  one EDGE entry list, last-per-commit flagged `EDGE_LAST_FLAG` — the only
 *  conditional chunk. */
function planEdges(
  sortedCommits: readonly CommitGraphWriterCommit[],
  positionOf: ReadonlyMap<ObjectId, number>,
): EdgePlan {
  const entries: number[] = [];
  const startByCommit = new Map<ObjectId, number>();
  for (const commit of sortedCommits) {
    if (commit.parents.length < 3) continue;
    startByCommit.set(commit.id, entries.length);
    const extra = commit.parents.slice(1);
    extra.forEach((parentId, i) => {
      const position = positionOf.get(parentId)!;
      entries.push(i === extra.length - 1 ? position | EDGE_LAST_FLAG : position);
    });
  }
  return { entries, startByCommit };
}

interface OptionalChunkCounts {
  /** Whether the layer carries GDA2 — git's `write_generation_data`. */
  readonly generationData: boolean;
  readonly overflowEntryCount: number;
  readonly edgeEntryCount: number;
  readonly baseLayerCount: number;
  /** `BDAT`'s filter bytes, or `undefined` when the graph carries no Bloom chunks. */
  readonly bloomDataSize: number | undefined;
}

function planChunks(
  commitCount: number,
  hashLength: number,
  {
    generationData,
    overflowEntryCount,
    edgeEntryCount,
    baseLayerCount,
    bloomDataSize,
  }: OptionalChunkCounts,
): ChunkSpec[] {
  const cdatEntrySize = hashLength + CDAT_FIXED_SIZE;
  const specs: ChunkSpec[] = [
    { id: 'OIDF', size: FANOUT_SIZE },
    { id: 'OIDL', size: commitCount * hashLength },
    { id: 'CDAT', size: commitCount * cdatEntrySize },
  ];
  if (generationData) specs.push({ id: 'GDA2', size: commitCount * 4 });
  if (overflowEntryCount > 0)
    specs.push({ id: 'GDO2', size: overflowEntryCount * GDO2_ENTRY_SIZE });
  if (edgeEntryCount > 0) specs.push({ id: 'EDGE', size: edgeEntryCount * 4 });
  if (bloomDataSize !== undefined) {
    specs.push({ id: 'BIDX', size: commitCount * BLOOM_INDEX_ENTRY_SIZE });
    specs.push({ id: 'BDAT', size: BLOOM_DATA_HEADER_SIZE + bloomDataSize });
  }
  if (baseLayerCount > 0) specs.push({ id: 'BASE', size: baseLayerCount * hashLength });
  return specs;
}

function computeChunkOffsets(specs: readonly ChunkSpec[]): readonly number[] {
  const tableSize = (specs.length + 1) * CHUNK_TABLE_ROW_SIZE;
  const offsets: number[] = [HEADER_SIZE + tableSize];
  for (const spec of specs) offsets.push(offsets[offsets.length - 1]! + spec.size);
  return offsets;
}

function writeHeaderAndChunkTable(
  bytes: Uint8Array,
  view: DataView,
  hashVersion: 1 | 2,
  chunkSpecs: readonly ChunkSpec[],
  offsets: readonly number[],
  trailerStart: number,
): void {
  bytes.set(encode(MAGIC), 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, hashVersion);
  view.setUint8(6, chunkSpecs.length);

  chunkSpecs.forEach((spec, i) => {
    const rowStart = HEADER_SIZE + i * CHUNK_TABLE_ROW_SIZE;
    bytes.set(encode(spec.id), rowStart);
    setUint64BE(view, rowStart + 4, offsets[i]!);
  });
  // Trailer row: zero id (already zero-initialised) + the trailer's own offset.
  setUint64BE(view, HEADER_SIZE + chunkSpecs.length * CHUNK_TABLE_ROW_SIZE + 4, trailerStart);
}

function writeOidfAndOidl(
  bytes: Uint8Array,
  view: DataView,
  sortedCommits: readonly CommitGraphWriterCommit[],
  fanoutOffset: number,
  lookupOffset: number,
  hashLength: number,
): void {
  const fanout = new Uint32Array(FANOUT_ENTRIES);
  for (const commit of sortedCommits) {
    const firstByte = hexToBytes(commit.id)[0]!;
    // Stryker disable next-line EqualityOperator: equivalent — fanout is a fixed-size Uint32Array(256); a write at the out-of-bounds index 256 is silently discarded (TypedArray out-of-range assignment is a no-op), identical to never reaching it.
    for (let i = firstByte; i < FANOUT_ENTRIES; i += 1) fanout[i]! += 1;
  }
  // Stryker disable next-line EqualityOperator: equivalent — the out-of-bounds read at i=256 writes a 0 at the OIDL chunk's first byte, immediately overwritten by the OIDL write below in this same function; the final buffer is unaffected.
  for (let i = 0; i < FANOUT_ENTRIES; i += 1) view.setUint32(fanoutOffset + i * 4, fanout[i]!);

  sortedCommits.forEach((commit, i) => {
    bytes.set(hexToBytes(commit.id), lookupOffset + i * hashLength);
  });
}

function resolveParent2(
  commit: CommitGraphWriterCommit,
  positionOf: ReadonlyMap<ObjectId, number>,
  edgePlan: EdgePlan,
): number {
  if (commit.parents.length <= 1) return NO_PARENT;
  if (commit.parents.length === 2) return positionOf.get(commit.parents[1]!)!;
  return OCTOPUS_FLAG | edgePlan.startByCommit.get(commit.id)!;
}

function writeCommitData(
  bytes: Uint8Array,
  view: DataView,
  sortedCommits: readonly CommitGraphWriterCommit[],
  positionOf: ReadonlyMap<ObjectId, number>,
  generations: ReadonlyMap<ObjectId, Generation>,
  cdatOffset: number,
  entrySize: number,
  hashLength: number,
  edgePlan: EdgePlan,
): void {
  sortedCommits.forEach((commit, i) => {
    const entryStart = cdatOffset + i * entrySize;
    bytes.set(hexToBytes(commit.rootTree), entryStart);

    const parent1 = commit.parents.length >= 1 ? positionOf.get(commit.parents[0]!)! : NO_PARENT;
    const parent2 = resolveParent2(commit, positionOf, edgePlan);
    view.setUint32(entryStart + hashLength, parent1);
    view.setUint32(entryStart + hashLength + 4, parent2);

    const { level } = generations.get(commit.id)!;
    // git never refuses a committer date past the 34-bit CDAT ceiling — it
    // computes this exact split unconditionally and the top bits silently
    // wrap; matching that wrap is what byte-identical means here (measured:
    // `git commit-graph write` on such a date exits 0, and only
    // `git commit-graph verify` later flags the mismatch).
    const dateHigh = Math.floor(commit.committerDate / 0x100000000) & 0x3;
    const dateLow = commit.committerDate % 0x100000000;
    view.setUint32(entryStart + hashLength + 8, level * 4 + dateHigh);
    view.setUint32(entryStart + hashLength + 12, dateLow);
  });
}

function writeGenerationData(
  view: DataView,
  sortedCommits: readonly CommitGraphWriterCommit[],
  generations: ReadonlyMap<ObjectId, Generation>,
  overflowPlan: OverflowPlan,
  gda2Offset: number,
): void {
  sortedCommits.forEach((commit, i) => {
    const overflowIndex = overflowPlan.indexByCommit.get(commit.id);
    const value =
      overflowIndex === undefined
        ? generations.get(commit.id)!.correctedDate - commit.committerDate
        : GENERATION_OVERFLOW_FLAG | overflowIndex;
    view.setUint32(gda2Offset + i * 4, value);
  });
}

function writeOverflowGenerationChunk(
  view: DataView,
  entries: readonly number[],
  gdo2Offset: number,
): void {
  entries.forEach((value, i) => {
    setUint64BE(view, gdo2Offset + i * GDO2_ENTRY_SIZE, value);
  });
}

function writeEdgeChunk(view: DataView, entries: readonly number[], edgeOffset: number): void {
  entries.forEach((value, i) => {
    view.setUint32(edgeOffset + i * 4, value);
  });
}

function bloomDataSize(
  sortedCommits: readonly CommitGraphWriterCommit[],
  filters: ReadonlyMap<ObjectId, Uint8Array>,
): number {
  return sortedCommits.reduce((size, commit) => size + (filters.get(commit.id)?.length ?? 0), 0);
}

/** git's `write_graph_chunk_bloom_indexes`/`_data`: each commit's cumulative filter end, then
 *  the settings header and every filter, both in oid order. */
function writeBloomChunks(
  bytes: Uint8Array,
  view: DataView,
  sortedCommits: readonly CommitGraphWriterCommit[],
  { settings, filters }: CommitGraphChangedPaths,
  chunkOffset: (id: string) => number,
): void {
  const indexOffset = chunkOffset('BIDX');
  const dataOffset = chunkOffset('BDAT');
  view.setUint32(dataOffset, settings.hashVersion);
  view.setUint32(dataOffset + 4, settings.numHashes);
  view.setUint32(dataOffset + 8, settings.bitsPerEntry);
  let end = 0;
  sortedCommits.forEach((commit, i) => {
    const filter = filters.get(commit.id) ?? EMPTY_FILTER;
    bytes.set(filter, dataOffset + BLOOM_DATA_HEADER_SIZE + end);
    end += filter.length;
    view.setUint32(indexOffset + i * BLOOM_INDEX_ENTRY_SIZE, end);
  });
}

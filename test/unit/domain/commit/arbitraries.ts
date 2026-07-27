import fc from 'fast-check';

import {
  EDGE_LAST_FLAG,
  NO_PARENT,
  OCTOPUS_FLAG,
} from '../../../../src/domain/commit/commit-graph.js';
import { compareBytes, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { arbObjectId } from '../objects/arbitraries.js';

export { arbObjectId } from '../objects/arbitraries.js';

const HEADER_SIZE = 8;
const CHUNK_TABLE_ROW_SIZE = 12;
const FANOUT_SIZE = 1024;
const CDAT_FIXED_SIZE = 16;

export interface CommitGraphCommitModel {
  readonly oid: ObjectId;
  readonly rootTree: ObjectId;
  readonly parentPositions: readonly number[];
  readonly generationV1: number;
  readonly committerDate: number;
  readonly generationV2Offset: number;
}

export interface CommitGraphLayerModel {
  readonly hashVersion: 1 | 2;
  readonly numBaseGraphs: number;
  readonly baseGraphHashes: readonly ObjectId[];
  readonly commits: readonly CommitGraphCommitModel[];
  readonly includeGenerationData: boolean;
}

function hashLengthFor(hashVersion: 1 | 2): number {
  return hashVersion === 1 ? 20 : 32;
}

function setUint64BE(view: DataView, offset: number, value: number): void {
  const high = Math.floor(value / 0x100000000);
  const low = value % 0x100000000;
  view.setUint32(offset, high);
  view.setUint32(offset + 4, low);
}

interface EdgePlan {
  readonly entries: readonly number[];
  readonly startByCommit: ReadonlyArray<number | undefined>;
}

function planEdgeChunk(commits: ReadonlyArray<CommitGraphCommitModel>): EdgePlan {
  const entries: number[] = [];
  const startByCommit: (number | undefined)[] = [];
  for (const commit of commits) {
    if (commit.parentPositions.length < 3) {
      startByCommit.push(undefined);
      continue;
    }
    startByCommit.push(entries.length);
    const extra = commit.parentPositions.slice(1);
    extra.forEach((pos, i) => {
      const isLast = i === extra.length - 1;
      entries.push(isLast ? pos | EDGE_LAST_FLAG : pos);
    });
  }
  return { entries, startByCommit };
}

/**
 * Test-only encoder for the `commit-graph` on-disk format (Pin D). Production code never
 * writes this format — `commit-graph` generation is out of scope — so the encoder lives
 * beside the arbitraries it serves, giving `parseCommitGraphLayer` a round-trip oracle.
 */
export function buildCommitGraphBytes(model: CommitGraphLayerModel): Uint8Array {
  const hashLength = hashLengthFor(model.hashVersion);
  const commitCount = model.commits.length;
  const cdatEntrySize = hashLength + CDAT_FIXED_SIZE;
  const edgePlan = planEdgeChunk(model.commits);

  const chunkSpecs: { readonly id: string; readonly size: number }[] = [
    { id: 'OIDF', size: FANOUT_SIZE },
    { id: 'OIDL', size: commitCount * hashLength },
    { id: 'CDAT', size: commitCount * cdatEntrySize },
  ];
  if (edgePlan.entries.length > 0) {
    chunkSpecs.push({ id: 'EDGE', size: edgePlan.entries.length * 4 });
  }
  if (model.includeGenerationData) {
    chunkSpecs.push({ id: 'GDA2', size: commitCount * 4 });
  }
  if (model.baseGraphHashes.length > 0) {
    chunkSpecs.push({ id: 'BASE', size: model.baseGraphHashes.length * hashLength });
  }

  const numChunks = chunkSpecs.length;
  const tableSize = (numChunks + 1) * CHUNK_TABLE_ROW_SIZE;
  const offsets: number[] = [HEADER_SIZE + tableSize];
  for (const spec of chunkSpecs) {
    offsets.push(offsets[offsets.length - 1]! + spec.size);
  }
  const trailerStart = offsets[offsets.length - 1]!;
  const bytes = new Uint8Array(trailerStart + hashLength);
  const view = new DataView(bytes.buffer);
  const textEncoder = new TextEncoder();

  bytes.set(textEncoder.encode('CGPH'), 0);
  view.setUint8(4, 1);
  view.setUint8(5, model.hashVersion);
  view.setUint8(6, numChunks);
  view.setUint8(7, model.numBaseGraphs);

  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = HEADER_SIZE + i * CHUNK_TABLE_ROW_SIZE;
    bytes.set(textEncoder.encode(chunkSpecs[i]!.id), rowStart);
    setUint64BE(view, rowStart + 4, offsets[i]!);
  }
  setUint64BE(view, HEADER_SIZE + numChunks * CHUNK_TABLE_ROW_SIZE + 4, trailerStart);

  const chunkOffset = (id: string): number => offsets[chunkSpecs.findIndex((s) => s.id === id)]!;

  writeFanoutAndLookup(
    bytes,
    view,
    model.commits,
    chunkOffset('OIDF'),
    chunkOffset('OIDL'),
    hashLength,
  );
  writeCommitData(
    bytes,
    view,
    model.commits,
    chunkOffset('CDAT'),
    cdatEntrySize,
    hashLength,
    edgePlan,
  );

  if (edgePlan.entries.length > 0) {
    const edgeOffset = chunkOffset('EDGE');
    edgePlan.entries.forEach((value, i) => {
      view.setUint32(edgeOffset + i * 4, value);
    });
  }

  if (model.includeGenerationData) {
    const gda2Offset = chunkOffset('GDA2');
    model.commits.forEach((commit, i) => {
      view.setUint32(gda2Offset + i * 4, commit.generationV2Offset);
    });
  }

  if (model.baseGraphHashes.length > 0) {
    const baseOffset = chunkOffset('BASE');
    model.baseGraphHashes.forEach((oid, i) => {
      bytes.set(hexToBytes(oid), baseOffset + i * hashLength);
    });
  }

  return bytes;
}

function writeFanoutAndLookup(
  bytes: Uint8Array,
  view: DataView,
  commits: ReadonlyArray<CommitGraphCommitModel>,
  fanoutOffset: number,
  lookupOffset: number,
  hashLength: number,
): void {
  const fanout = new Uint32Array(256);
  for (const commit of commits) {
    const firstByte = hexToBytes(commit.oid)[0]!;
    for (let i = firstByte; i < 256; i += 1) fanout[i]! += 1;
  }
  for (let i = 0; i < 256; i += 1) view.setUint32(fanoutOffset + i * 4, fanout[i]!);

  commits.forEach((commit, i) => {
    bytes.set(hexToBytes(commit.oid), lookupOffset + i * hashLength);
  });
}

function writeCommitData(
  bytes: Uint8Array,
  view: DataView,
  commits: ReadonlyArray<CommitGraphCommitModel>,
  cdatOffset: number,
  cdatEntrySize: number,
  hashLength: number,
  edgePlan: EdgePlan,
): void {
  commits.forEach((commit, i) => {
    const entryStart = cdatOffset + i * cdatEntrySize;
    bytes.set(hexToBytes(commit.rootTree), entryStart);

    const { parentPositions } = commit;
    const parent1 = parentPositions.length >= 1 ? parentPositions[0]! : NO_PARENT;
    const parent2 = resolveParent2(parentPositions, edgePlan.startByCommit[i]);
    view.setUint32(entryStart + hashLength, parent1);
    view.setUint32(entryStart + hashLength + 4, parent2);

    const dateHigh = Math.floor(commit.committerDate / 0x100000000) & 0x3;
    const dateLow = commit.committerDate % 0x100000000;
    view.setUint32(entryStart + hashLength + 8, commit.generationV1 * 4 + dateHigh);
    view.setUint32(entryStart + hashLength + 12, dateLow);
  });
}

function resolveParent2(parentPositions: readonly number[], edgeStart: number | undefined): number {
  if (parentPositions.length <= 1) return NO_PARENT;
  if (parentPositions.length === 2) return parentPositions[1]!;
  return OCTOPUS_FLAG | edgeStart!;
}

/** An arbitrary, internally-consistent single-layer commit-graph model (safe subset). */
export function arbCommitGraphLayerModel(): fc.Arbitrary<CommitGraphLayerModel> {
  return fc.constantFrom<1 | 2>(1, 2).chain((hashVersion) =>
    fc.integer({ min: 1, max: 6 }).chain((commitCount) => {
      const hashLength = hashLengthFor(hashVersion);
      return fc
        .record({
          oids: fc.uniqueArray(arbObjectId(hashLength === 20 ? 40 : 64), {
            minLength: commitCount,
            maxLength: commitCount,
          }),
          rootTrees: fc.array(arbObjectId(hashLength === 20 ? 40 : 64), {
            minLength: commitCount,
            maxLength: commitCount,
          }),
          parentPositionsList: fc.array(
            fc.uniqueArray(fc.integer({ min: 0, max: commitCount - 1 }), { maxLength: 4 }),
            { minLength: commitCount, maxLength: commitCount },
          ),
          generationV1List: fc.array(fc.integer({ min: 0, max: 0x3fffffff }), {
            minLength: commitCount,
            maxLength: commitCount,
          }),
          committerDateList: fc.array(fc.integer({ min: 0, max: 2 ** 34 - 1 }), {
            minLength: commitCount,
            maxLength: commitCount,
          }),
          generationV2OffsetList: fc.array(fc.integer({ min: 0, max: 0x7fffffff }), {
            minLength: commitCount,
            maxLength: commitCount,
          }),
          includeGenerationData: fc.boolean(),
          baseGraphHashes: fc.uniqueArray(arbObjectId(hashLength === 20 ? 40 : 64), {
            maxLength: 3,
          }),
        })
        .map((r) => {
          const sortedOids = [...r.oids].sort((a, b) => compareBytes(hexToBytes(a), hexToBytes(b)));
          const commits: CommitGraphCommitModel[] = sortedOids.map((oid, i) => ({
            oid,
            rootTree: r.rootTrees[i]!,
            parentPositions: r.parentPositionsList[i]!,
            generationV1: r.generationV1List[i]!,
            committerDate: r.committerDateList[i]!,
            generationV2Offset: r.generationV2OffsetList[i]!,
          }));
          return {
            hashVersion,
            numBaseGraphs: r.baseGraphHashes.length,
            baseGraphHashes: r.baseGraphHashes,
            commits,
            includeGenerationData: r.includeGenerationData,
          };
        });
    }),
  );
}

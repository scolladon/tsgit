/**
 * The structural half of git's `verify_one_commit_graph`: OID order, fanout
 * and each commit's own parse from the graph — everything decided from the
 * graph bytes alone, before any commit is compared with the object database.
 */
import { bytesToHex, compareBytes } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import { type CommitGraphLayer, commitParentPositionsAt, graphParentsAt } from './commit-graph.js';
import type { CommitGraphLoadFailure } from './commit-graph-load.js';

/** One disagreement `git commit-graph verify` reports, keyed by the check that failed. */
export type CommitGraphVerdict =
  | { readonly check: 'checksum' }
  | { readonly check: 'load-failure'; readonly failure: CommitGraphLoadFailure }
  | { readonly check: 'oid-order'; readonly previous: ObjectId; readonly id: ObjectId }
  | {
      readonly check: 'fanout';
      readonly bucket: number;
      readonly recordedCount: number;
      readonly expectedCount: number;
    }
  | { readonly check: 'graph-unparsable'; readonly id: ObjectId }
  /** An octopus parent list running past the EDGE chunk, or naming one that is absent. */
  | { readonly check: 'extra-edges-out-of-bounds' }
  | { readonly check: 'invalid-parent-position'; readonly position: number }
  | { readonly check: 'odb-unparsable'; readonly id: ObjectId }
  | {
      readonly check: 'root-tree' | 'parent';
      readonly id: ObjectId;
      readonly recorded: ObjectId;
      readonly actual: ObjectId;
    }
  | { readonly check: 'parents-too-long' | 'parents-terminate-early'; readonly id: ObjectId }
  | {
      readonly check: 'generation';
      readonly id: ObjectId;
      readonly generation: number;
      readonly minimum: number;
    }
  | {
      readonly check: 'commit-date';
      readonly id: ObjectId;
      readonly recordedDate: number;
      readonly actualDate: number;
    }
  | { readonly check: 'mixed-generations'; readonly zero: ObjectId; readonly nonZero: ObjectId }
  /** The chain file could not be opened for a reason other than its absence — `code` names it. */
  | { readonly check: 'chain-unopenable'; readonly code: string }
  /** A chain layer git's loader refuses; the next source is searched for it. */
  | {
      readonly check: 'layer-load-failure';
      readonly layer: string;
      readonly failure: CommitGraphLoadFailure;
    }
  | { readonly check: 'chain-line-not-hash'; readonly line: string }
  | {
      readonly check:
        | 'chain-too-small'
        | 'chain-no-base-chunk'
        | 'chain-base-chunk-too-small'
        | 'chain-mismatch'
        | 'chain-layer-missing'
        | 'chain-incomplete'
        /** No layer loaded: git's verify fails without a line of its own. */
        | 'chain-unloaded';
    };

export interface StructuralVerdicts {
  readonly verdicts: ReadonlyArray<CommitGraphVerdict>;
  /** A parent position past the graph's end: git dies there, verifying nothing more. */
  readonly fatal: boolean;
}

const FANOUT_BUCKETS = 256;

/** The raw OID stored at layer-local `position`. */
export function graphOidBytesAt(layer: CommitGraphLayer, position: number): Uint8Array {
  const start = layer._oidLookupOffset + position * layer._hashLength;
  return layer._bytes.subarray(start, start + layer._hashLength);
}

export const graphOidAt = (layer: CommitGraphLayer, position: number): ObjectId =>
  bytesToHex(graphOidBytesAt(layer, position)) as ObjectId;

const fanoutAt = (layer: CommitGraphLayer, bucket: number): number =>
  layer._view.getUint32(layer._fanoutOffset + bucket * 4);

/** git's hash-table binary search: between the bucket's two fanout bounds, as recorded. */
export function findGraphPosition(layer: CommitGraphLayer, oid: Uint8Array): number | undefined {
  const first = oid[0] as number;
  let low = first === 0 ? 0 : fanoutAt(layer, first - 1);
  let high = fanoutAt(layer, first);
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const cmp = compareBytes(graphOidBytesAt(layer, mid), oid);
    if (cmp === 0) return mid;
    if (cmp > 0) high = mid;
    else low = mid + 1;
  }
  return undefined;
}

/** Every parent position the graph records for `position`, in parent order. */
export function graphParentPositions(
  layer: CommitGraphLayer,
  position: number,
): ReadonlyArray<number> {
  const data = commitParentPositionsAt(layer, position);
  const second = data.parent2Pos === undefined ? [] : [data.parent2Pos];
  const first = data.parent1Pos === undefined ? [] : [data.parent1Pos];
  return [...first, ...second, ...data.additionalParentPositions];
}

interface Walk {
  readonly verdicts: CommitGraphVerdict[];
  fanoutBucket: number;
}

function checkFanoutUpTo(layer: CommitGraphLayer, walk: Walk, limit: number, at: number): void {
  while (walk.fanoutBucket < limit) {
    const recorded = fanoutAt(layer, walk.fanoutBucket);
    if (recorded !== at) {
      walk.verdicts.push({
        check: 'fanout',
        bucket: walk.fanoutBucket,
        recordedCount: recorded,
        expectedCount: at,
      });
    }
    walk.fanoutBucket += 1;
  }
}

function checkOrder(layer: CommitGraphLayer, walk: Walk, position: number): void {
  if (position === 0) return;
  const previous = graphOidBytesAt(layer, position - 1);
  if (compareBytes(previous, graphOidBytesAt(layer, position)) < 0) return;
  walk.verdicts.push({
    check: 'oid-order',
    previous: graphOidAt(layer, position - 1),
    id: graphOidAt(layer, position),
  });
}

/** git's `parse_commit_in_graph_one`; `false` when it dies on a parent position. */
function parseInGraph(
  layer: CommitGraphLayer,
  walk: Walk,
  position: number,
  total: number,
): boolean {
  const oid = graphOidBytesAt(layer, position);
  const found = findGraphPosition(layer, oid);
  if (found === undefined) {
    walk.verdicts.push({ check: 'graph-unparsable', id: graphOidAt(layer, position) });
    return true;
  }
  const parents = graphParentsAt(layer, found);
  const beyond = parents.positions.find((parent) => parent >= total);
  if (beyond !== undefined) {
    walk.verdicts.push({ check: 'invalid-parent-position', position: beyond });
    return false;
  }
  if (parents.edgesOutOfBounds) {
    walk.verdicts.push({ check: 'extra-edges-out-of-bounds' });
    walk.verdicts.push({ check: 'graph-unparsable', id: graphOidAt(layer, position) });
  }
  return true;
}

/** Phase one of git's `verify_one_commit_graph`, over a layer holding `total` commits in scope. */
export function verifyGraphStructure(layer: CommitGraphLayer, total: number): StructuralVerdicts {
  const walk: Walk = { verdicts: [], fanoutBucket: 0 };
  for (let position = 0; position < layer.commitCount; position += 1) {
    checkOrder(layer, walk, position);
    checkFanoutUpTo(layer, walk, graphOidBytesAt(layer, position)[0] as number, position);
    if (!parseInGraph(layer, walk, position, total))
      return { verdicts: walk.verdicts, fatal: true };
  }
  checkFanoutUpTo(layer, walk, FANOUT_BUCKETS, layer.commitCount);
  return { verdicts: walk.verdicts, fatal: false };
}

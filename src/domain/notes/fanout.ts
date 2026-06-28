import { ObjectId } from '../objects/index.js';
import type { NotesTrie } from './types.js';

const HEX_PER_BYTE = 2;

const isBranch = (kind: string): boolean => kind === 'subtree' || kind === 'internal';

/**
 * git's fanout heuristic: at even, in-range depths a node whose every slot is a
 * populated branch deepens the on-disk fanout by one byte; otherwise the depth
 * is left as-is. This is why the flat→fanned flip is distribution-dependent and
 * sticky (untouched lazy siblings keep re-satisfying the all-branches test).
 */
export const determineFanout = (node: NotesTrie, n: number, fanout: number): number => {
  if (n % HEX_PER_BYTE !== 0 || n > HEX_PER_BYTE * fanout) return fanout;
  return node.slots.every((slot) => isBranch(slot.kind)) ? fanout + 1 : fanout;
};

/** Lays an oid out with `fanout` leading bytes as `XX/` directory components. */
export const constructPathWithFanout = (oid: ObjectId, fanout: number): string => {
  const dirs = Array.from({ length: fanout }, (_, i) =>
    oid.slice(HEX_PER_BYTE * i, HEX_PER_BYTE * i + HEX_PER_BYTE),
  );
  return [...dirs, oid.slice(HEX_PER_BYTE * fanout)].join('/');
};

/** Inverse of `constructPathWithFanout`: strips the separators back to the oid. */
export const parseFanoutPath = (path: string): ObjectId => ObjectId.from(path.split('/').join(''));

/** Splits a consumed hex prefix into its `XX/` directory components. */
export const constructSubtreePath = (prefix: string): string => {
  const chunks = Array.from({ length: prefix.length / HEX_PER_BYTE }, (_, i) =>
    prefix.slice(HEX_PER_BYTE * i, HEX_PER_BYTE * i + HEX_PER_BYTE),
  );
  return chunks.join('/');
};

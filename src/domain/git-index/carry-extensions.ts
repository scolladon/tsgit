import { errorDataCode } from '../error-data-code.js';
import { compareBytes, encode } from '../objects/encoding.js';
import type { FilePath } from '../objects/index.js';
import { invalidateCacheTree, serializeCacheTree } from './cache-tree.js';
import type { IndexChange } from './diff-index-entries.js';
import type { IndexExtension } from './index-entry.js';
import { parseCacheTree } from './index-parser.js';

export type CarryKind = 'refresh' | 'update' | 'replace';

export interface CarrySettings {
  readonly untrackedCache: boolean | undefined;
  readonly digestLength: 20 | 32;
}

const TREE_SIGNATURE = 'TREE';
const REUC_SIGNATURE = 'REUC';
const UNTR_SIGNATURE = 'UNTR';

export const NO_INDEX_CHANGE: IndexChange = {
  changedPaths: [],
  trackedSetChanged: false,
  resolvedUnmerged: false,
};

const findExtension = (
  previous: ReadonlyArray<IndexExtension>,
  signature: string,
): IndexExtension | undefined => previous.find((extension) => extension.signature === signature);

const INVALID_INDEX_ENTRY_CODE = 'INVALID_INDEX_ENTRY';

const carryTree = (
  tree: IndexExtension | undefined,
  change: IndexChange,
  kind: CarryKind,
  digestLength: 20 | 32,
): IndexExtension | undefined => {
  if (tree === undefined || kind === 'refresh' || change.changedPaths.length === 0) return tree;
  try {
    const invalidated = invalidateCacheTree(
      parseCacheTree(tree.data, digestLength),
      change.changedPaths,
    );
    return { signature: TREE_SIGNATURE, data: serializeCacheTree(invalidated, digestLength) };
  } catch (err) {
    if (errorDataCode(err) === INVALID_INDEX_ENTRY_CODE) return undefined;
    throw err;
  }
};

const carryUnmerged = (
  reuc: IndexExtension | undefined,
  change: IndexChange,
  kind: CarryKind,
): IndexExtension | undefined => {
  if (kind === 'replace') return undefined;
  return kind === 'update' && change.resolvedUnmerged ? undefined : reuc;
};

const carryUntracked = (
  untr: IndexExtension | undefined,
  change: IndexChange,
  kind: CarryKind,
  untrackedCache: boolean | undefined,
): IndexExtension | undefined => {
  if (untrackedCache === false) return undefined;
  if (kind === 'refresh') return untr;
  return change.trackedSetChanged ? undefined : untr;
};

export const carryExtensions = (
  previous: ReadonlyArray<IndexExtension>,
  change: IndexChange,
  kind: CarryKind,
  settings: CarrySettings,
): ReadonlyArray<IndexExtension> => {
  if (previous.length === 0) return [];
  return [
    carryTree(findExtension(previous, TREE_SIGNATURE), change, kind, settings.digestLength),
    carryUnmerged(findExtension(previous, REUC_SIGNATURE), change, kind),
    carryUntracked(findExtension(previous, UNTR_SIGNATURE), change, kind, settings.untrackedCache),
  ].filter((extension) => extension !== undefined);
};

const byUtf8Bytes = (a: FilePath, b: FilePath): number => compareBytes(encode(a), encode(b));

export const withRestagedPaths = (
  change: IndexChange,
  restagedPaths: ReadonlyArray<FilePath>,
): IndexChange => {
  if (restagedPaths.length === 0) return change;
  const union = [...new Set([...change.changedPaths, ...restagedPaths])].sort(byUtf8Bytes);
  return { ...change, changedPaths: union };
};

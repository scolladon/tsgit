import type {
  EscapedFlatTree,
  FlatTree,
  FlatTreeEntry,
} from '../../../src/domain/diff/flat-tree.js';
import type { FilePath } from '../../../src/domain/objects/index.js';

/** The one cast for hand-built fixtures: their keys are plain ASCII, so already escaped paths. */
export const escapedFlatTree = (entries: Iterable<[string, FlatTreeEntry]>): EscapedFlatTree => {
  const tree: FlatTree = {
    entries: new Map([...entries].map(([path, entry]) => [path as FilePath, entry] as const)),
  };
  return tree as EscapedFlatTree;
};

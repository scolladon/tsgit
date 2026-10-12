/** git's default `commit-graph write --size-multiple`. */
const SIZE_MULTIPLE = 2;

/**
 * git's `split_graph_merge_strategy` at default settings: walking down from
 * the tip, a layer folds into the one being written while it holds no more
 * than `SIZE_MULTIPLE` times the commits gathered so far. `layerCommitCounts`
 * runs base first; the answer is how many tip layers merge.
 */
export function mergedLayerCount(
  layerCommitCounts: readonly number[],
  newCommitCount: number,
): number {
  let gathered = newCommitCount;
  let merged = 0;
  for (const count of [...layerCommitCounts].reverse()) {
    if (count > SIZE_MULTIPLE * gathered) break;
    gathered += count;
    merged += 1;
  }
  return merged;
}

import type { PullResult } from '../../src/application/commands/pull.js';

export type MergedPull = Extract<PullResult, { readonly integration: 'merge' }>;

/** Narrow a pull the test expects to have integrated by merge, failing loudly otherwise. */
export const mergedPull = (result: PullResult): MergedPull => {
  if (result.integration !== 'merge')
    throw new Error(`expected a merging pull, got ${result.integration}`);
  return result;
};

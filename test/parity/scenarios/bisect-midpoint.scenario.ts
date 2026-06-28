/**
 * Bisect-midpoint scenario — seeds a three-commit linear history (root → mid →
 * bad) and runs `repo.primitives.bisectMidpoint` with good=root, bad=bad.
 * Verifies that the structured counts are identical across Node, memory, and
 * the browser adapters.
 *
 * 2 candidates (mid, bad): best = mid with weight=1.
 *   candidateCount=2, remainingIfGood=0, remainingIfBad=0, remainingSteps=0
 */
import type { ObjectId } from '../../../src/domain/objects/object-id.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface BisectMidpointResult {
  readonly nextCommitDefined: boolean;
  readonly candidateCount: number;
  readonly remainingIfGood: number;
  readonly remainingIfBad: number;
  readonly remainingSteps: number;
}

export const bisectMidpointScenario: Scenario<BisectMidpointResult> = {
  name: 'bisect-midpoint',
  inputs: { files: [], author: AUTHOR, message: 'seed' },
  expected: {
    nextCommitDefined: true,
    candidateCount: 2,
    remainingIfGood: 0,
    remainingIfBad: 0,
    remainingSteps: 0,
  },
  run: async (repo, inputs) => {
    await repo.init();
    const treeId: ObjectId = await repo.primitives.writeObject({
      type: 'tree',
      id: '' as ObjectId,
      entries: [],
    });
    const mkCommit = (ts: number, parents: ObjectId[]): Promise<ObjectId> =>
      repo.primitives.createCommit({
        tree: treeId,
        parents,
        author: { ...inputs.author, timestamp: ts },
        committer: { ...inputs.author, timestamp: ts },
        message: `c@${ts}`,
      });

    const root = await mkCommit(100, []);
    const mid = await mkCommit(101, [root]);
    const bad = await mkCommit(102, [mid]);

    const result = await repo.primitives.bisectMidpoint([root], bad);
    return {
      nextCommitDefined: result !== undefined,
      candidateCount: result?.candidateCount ?? 0,
      remainingIfGood: result?.remainingIfGood ?? 0,
      remainingIfBad: result?.remainingIfBad ?? 0,
      remainingSteps: result?.remainingSteps ?? 0,
    };
  },
};

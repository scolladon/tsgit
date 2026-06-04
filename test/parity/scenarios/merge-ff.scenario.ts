/**
 * Fast-forward merge scenario — creates `feature` on the seed commit,
 * advances it with one extra commit, then checks out `main` and merges
 * `feature`. With main an ancestor of feature, the merge is a pure ref
 * advance (no merge commit).
 *
 * Surfaces closed (per 19.5a):
 *   commands: merge
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface MergeFfResult {
  readonly seedCommitId: string;
  readonly featureCommitId: string;
  readonly mergeKind: string;
  readonly mergeId: string;
  readonly mergeBranch: string;
}

export const mergeFfScenario: Scenario<MergeFfResult> = {
  name: 'merge-ff',
  inputs: { files: [FILES.helloA, FILES.helloB], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    seedCommitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    featureCommitId: 'aaf0bbab5773df6abf0967d92199c55c1be97162',
    mergeKind: 'fast-forward',
    mergeId: 'aaf0bbab5773df6abf0967d92199c55c1be97162',
    mergeBranch: 'refs/heads/main',
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    await repo.branch.create({ name: 'feature' });
    await repo.checkout({ target: 'feature' });
    await repo.add(['b.txt']);
    const feature = await repo.commit({ message: MESSAGES.second, author: inputs.author });

    await repo.checkout({ target: 'main' });
    const result = await repo.merge.run({ target: 'feature' });

    if (result.kind !== 'fast-forward') {
      throw new Error(`merge-ff expected kind='fast-forward' but got kind='${result.kind}'`);
    }
    return {
      seedCommitId: seed.id,
      featureCommitId: feature.id,
      mergeKind: result.kind,
      mergeId: result.id,
      mergeBranch: result.branch,
    };
  },
};

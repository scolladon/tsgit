/**
 * Merge state-machine abort scenario — drives a conflict and then
 * `abortMerge` to restore the pre-merge branch state. The conflicting
 * merge is built on top of the FF fixture (two diverging commits on
 * `feature` vs `main` touching the same file).
 *
 * Surfaces closed (per 19.5a):
 *   commands: abortMerge
 */
import type { AuthorIdentity } from '../../../src/domain/objects/author-identity.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface MergeAbortResult {
  readonly seedCommitId: string;
  readonly mainTipId: string;
  readonly featureTipId: string;
  readonly mergeKind: string;
  readonly mergeHead: string;
  readonly origHead: string;
  readonly abortedBranch: string;
  readonly abortedOrigHead: string;
}

const conflictAuthor: AuthorIdentity = AUTHOR;

export const mergeAbortScenario: Scenario<MergeAbortResult> = {
  name: 'merge-abort',
  inputs: {
    files: [{ path: 'a.txt', content: 'base\n' }],
    author: conflictAuthor,
    message: 'seed commit',
  },
  expected: {
    seedCommitId: '050acef8d74a2991766ab2c8b4b07f1a6b970c2c',
    mainTipId: '7408810a6beb372a803f390eea727fe22ac23f01',
    featureTipId: 'de3648ccf0e9e5d2601b5abe99f0ab45361cbaa4',
    mergeKind: 'conflict',
    mergeHead: 'de3648ccf0e9e5d2601b5abe99f0ab45361cbaa4',
    origHead: '7408810a6beb372a803f390eea727fe22ac23f01',
    abortedBranch: 'refs/heads/main',
    abortedOrigHead: '7408810a6beb372a803f390eea727fe22ac23f01',
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    await repo.branch.create({ name: 'feature' });
    await repo.checkout({ target: 'feature' });
    // Overwrite the seed file on the feature branch.
    const ctx = repo.ctx;
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'FEATURE\n');
    await repo.add(['a.txt']);
    const feature = await repo.commit({ message: 'on-feature', author: inputs.author });

    await repo.checkout({ target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'MAIN\n');
    await repo.add(['a.txt']);
    const mainTip = await repo.commit({ message: 'on-main', author: inputs.author });

    const mergeResult = await repo.merge({ target: 'feature', author: inputs.author });
    if (mergeResult.kind !== 'conflict') {
      throw new Error(`merge-abort expected kind='conflict' but got kind='${mergeResult.kind}'`);
    }

    const aborted = await repo.abortMerge();

    return {
      seedCommitId: seed.id,
      mainTipId: mainTip.id,
      featureTipId: feature.id,
      mergeKind: mergeResult.kind,
      mergeHead: mergeResult.mergeHead,
      origHead: mergeResult.origHead,
      abortedBranch: aborted.branch,
      abortedOrigHead: aborted.origHead,
    };
  },
};

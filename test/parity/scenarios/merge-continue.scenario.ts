/**
 * Merge state-machine continue scenario — drives a conflict, then a
 * deterministic resolution (overwrite the file with a fixed payload and
 * stage), then `merge.continue` to produce the two-parent merge commit.
 *
 * Surfaces closed (per 19.5a):
 *   commands: merge
 */
import type { AuthorIdentity } from '../../../src/domain/objects/author-identity.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface MergeContinueResult {
  readonly seedCommitId: string;
  readonly mainTipId: string;
  readonly featureTipId: string;
  readonly mergeKind: string;
  readonly resolvedCommitId: string;
  readonly resolvedParents: ReadonlyArray<string>;
}

const conflictAuthor: AuthorIdentity = AUTHOR;

export const mergeContinueScenario: Scenario<MergeContinueResult> = {
  name: 'merge-continue',
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
    resolvedCommitId: 'c31cfb8215f2e29aa50d061134ebcfad13c51019',
    resolvedParents: [
      '7408810a6beb372a803f390eea727fe22ac23f01',
      'de3648ccf0e9e5d2601b5abe99f0ab45361cbaa4',
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    await repo.branch.create({ name: 'feature' });
    await repo.checkout({ rev: 'feature' });
    const ctx = repo.ctx;
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'FEATURE\n');
    await repo.add(['a.txt']);
    const feature = await repo.commit({ message: 'on-feature', author: inputs.author });

    await repo.checkout({ rev: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'MAIN\n');
    await repo.add(['a.txt']);
    const mainTip = await repo.commit({ message: 'on-main', author: inputs.author });

    const mergeResult = await repo.merge.run({
      rev: 'feature',
      author: inputs.author,
      message: 'Merge feature into main',
    });
    if (mergeResult.kind !== 'conflict') {
      throw new Error(`merge-continue expected kind='conflict' but got kind='${mergeResult.kind}'`);
    }

    // Deterministic resolution: overwrite the file with a known payload and stage.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'RESOLVED\n');
    await repo.add(['a.txt']);

    const resolved = await repo.merge.continue({
      message: 'resolved',
      author: inputs.author,
      committer: inputs.author,
    });

    return {
      seedCommitId: seed.id,
      mainTipId: mainTip.id,
      featureTipId: feature.id,
      mergeKind: mergeResult.kind,
      resolvedCommitId: resolved.id,
      resolvedParents: resolved.parents.slice(),
    };
  },
};

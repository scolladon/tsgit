/**
 * Merge state-machine continue scenario — drives a conflict, then a
 * deterministic resolution (overwrite the file with a fixed payload and
 * stage), then `continueMerge` to produce the two-parent merge commit.
 *
 * Surfaces closed (per 19.5a):
 *   commands: continueMerge
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
    seedCommitId: '16b29ce177c8b749666b19461fabf80c5875d411',
    mainTipId: '687afb9b0d26420e00ad01df2512550c03db3043',
    featureTipId: 'b6e273eaa47d481207f255bbe38fe412bbed46e1',
    mergeKind: 'conflict',
    resolvedCommitId: '32c49415f1a4eb29cdd2a1122aa9f1a1d7903f88',
    resolvedParents: [
      '687afb9b0d26420e00ad01df2512550c03db3043',
      'b6e273eaa47d481207f255bbe38fe412bbed46e1',
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    await repo.branch({ kind: 'create', name: 'feature' });
    await repo.checkout({ target: 'feature' });
    const ctx = repo.ctx;
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'FEATURE\n');
    await repo.add(['a.txt']);
    const feature = await repo.commit({ message: 'on-feature', author: inputs.author });

    await repo.checkout({ target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'MAIN\n');
    await repo.add(['a.txt']);
    const mainTip = await repo.commit({ message: 'on-main', author: inputs.author });

    const mergeResult = await repo.merge({
      target: 'feature',
      author: inputs.author,
      message: 'Merge feature into main',
    });
    if (mergeResult.kind !== 'conflict') {
      throw new Error(`merge-continue expected kind='conflict' but got kind='${mergeResult.kind}'`);
    }

    // Deterministic resolution: overwrite the file with a known payload and stage.
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'RESOLVED\n');
    await repo.add(['a.txt']);

    const resolved = await repo.continueMerge({
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

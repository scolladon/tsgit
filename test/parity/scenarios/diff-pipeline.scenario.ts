/**
 * Diff + merge-base scenario — drives a two-commit history then exercises
 * `diff` (command), `diffTrees`/`mergeBase`/`flattenTree` (primitives)
 * against it. With a linear history the merge base of the two commits is
 * the older commit; the diff between them yields one added file. A third
 * commit then rewrites `a.txt` with a whitespace-only change and `b.txt`
 * with a real one, exercising `diff`'s `ignoreWhitespace` option — no
 * `test/parity` scenario touched it before.
 *
 * Surfaces closed (per 19.5a):
 *   commands:   diff
 *   primitives: diffTrees, mergeBase, flattenTree
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface DiffPipelineResult {
  readonly firstCommitId: string;
  readonly secondCommitId: string;
  readonly diffAddedPaths: ReadonlyArray<string>;
  readonly diffTreesAddedPaths: ReadonlyArray<string>;
  readonly mergeBaseId: string;
  readonly flattenTreePaths: ReadonlyArray<string>;
  readonly ignoreWhitespaceSurvivingPaths: ReadonlyArray<string>;
}

export const diffPipelineScenario: Scenario<DiffPipelineResult> = {
  name: 'diff-pipeline',
  inputs: { files: [FILES.helloA, FILES.helloB], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    firstCommitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    secondCommitId: 'aaf0bbab5773df6abf0967d92199c55c1be97162',
    diffAddedPaths: ['b.txt'],
    diffTreesAddedPaths: ['b.txt'],
    mergeBaseId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    flattenTreePaths: ['a.txt', 'b.txt'],
    ignoreWhitespaceSurvivingPaths: ['b.txt'],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const first = await repo.commit({ message: inputs.message, author: inputs.author });
    await repo.add(['b.txt']);
    const second = await repo.commit({ message: MESSAGES.second, author: inputs.author });

    const diff = await repo.diff({ from: first.id, to: second.id });
    const diffTrees = await repo.primitives.diffTrees(first.id, second.id);
    const [mergeBase] = await repo.primitives.mergeBase([first.id, second.id]);
    const flatTree = await repo.primitives.flattenTree(second.tree);

    const ctx = repo.ctx;
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello  a\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'hello world\n');
    await repo.add(['a.txt', 'b.txt']);
    const third = await repo.commit({
      message: 'whitespace and real change',
      author: inputs.author,
    });

    const ignoreWhitespaceDiff = await repo.diff({
      from: second.id,
      to: third.id,
      ignoreWhitespace: 'all',
    });

    const addedPaths = (changes: ReadonlyArray<{ readonly type: string }>): ReadonlyArray<string> =>
      changes
        .filter(
          (change): change is { readonly type: 'add'; readonly newPath: string } & typeof change =>
            change.type === 'add',
        )
        .map((change) => change.newPath)
        .sort();

    const modifiedPaths = (
      changes: ReadonlyArray<{ readonly type: string }>,
    ): ReadonlyArray<string> =>
      changes
        .filter(
          (change): change is { readonly type: 'modify'; readonly path: string } & typeof change =>
            change.type === 'modify',
        )
        .map((change) => change.path)
        .sort();

    return {
      firstCommitId: first.id,
      secondCommitId: second.id,
      diffAddedPaths: addedPaths(diff.changes),
      diffTreesAddedPaths: addedPaths(diffTrees.changes),
      mergeBaseId: mergeBase ?? '',
      flattenTreePaths: [...flatTree.entries.keys()].sort(),
      ignoreWhitespaceSurvivingPaths: modifiedPaths(ignoreWhitespaceDiff.changes),
    };
  },
};

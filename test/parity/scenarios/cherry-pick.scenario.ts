/**
 * Cherry-pick round-trip scenario — pick a `feature` commit onto `main`. Captures
 * only deterministic observable state (result kind, picked count, working-tree
 * content): the created commit OID embeds the committer timestamp and so is not
 * comparable across runs.
 *
 * Surfaces closed:
 *   commands: cherryPick (run)
 */
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface CherryPickResult {
  readonly runKind: string;
  readonly featContent: string;
  readonly commitCount: number;
}

export const cherryPickScenario: Scenario<CherryPickResult> = {
  name: 'cherry-pick',
  inputs: { files: [{ path: 'base.txt', content: 'base\n' }], author: AUTHOR, message: 'base' },
  expected: {
    runKind: 'picked',
    featContent: 'feat\n',
    commitCount: 1,
  },
  run: async (repo, inputs) => {
    await repo.init();
    const ctx = repo.ctx;
    await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = P\n\temail = p@x\n');
    await repo.add(['base.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    await repo.branch.create({ name: 'feature' });
    await repo.checkout({ rev: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/feat.txt`, 'feat\n');
    await repo.add(['feat.txt']);
    await repo.commit({ message: 'add feat', author: inputs.author });
    await repo.checkout({ rev: 'main' });

    const result = await repo.cherryPick.run({ commits: ['feature'] });
    const featContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/feat.txt`);
    return {
      runKind: result.kind,
      featContent,
      commitCount: result.kind === 'picked' ? result.commits.length : -1,
    };
  },
};

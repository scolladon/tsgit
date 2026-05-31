/**
 * Revert round-trip scenario — revert the tip commit on `main`, undoing its
 * change. Captures only deterministic observable state (result kind, reverted
 * count, working-tree content): the created commit OID embeds the committer
 * timestamp and so is not comparable across runs.
 *
 * Surfaces closed:
 *   commands: revert (run)
 */
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface RevertScenarioResult {
  readonly runKind: string;
  readonly fileContent: string;
  readonly commitCount: number;
}

export const revertScenario: Scenario<RevertScenarioResult> = {
  name: 'revert',
  inputs: { files: [{ path: 'f.txt', content: 'v1\n' }], author: AUTHOR, message: 'base' },
  expected: {
    runKind: 'reverted',
    fileContent: 'v1\n',
    commitCount: 1,
  },
  run: async (repo, inputs) => {
    await repo.init();
    const ctx = repo.ctx;
    await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = R\n\temail = r@x\n');
    await repo.add(['f.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'v2\n');
    await repo.add(['f.txt']);
    await repo.commit({ message: 'change f', author: inputs.author });

    const result = await repo.revert.run({ commits: ['HEAD'] });
    const fileContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt`);
    return {
      runKind: result.kind,
      fileContent,
      commitCount: result.kind === 'reverted' ? result.commits.length : -1,
    };
  },
};

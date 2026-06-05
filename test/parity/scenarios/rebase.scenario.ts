/**
 * Rebase round-trip scenario — replay a one-commit topic branch onto an advanced
 * main. Captures only deterministic observable state (result kind, replayed
 * count, working-tree content): the replayed commit OID embeds the committer
 * timestamp and so is not comparable across runs.
 *
 * Surfaces closed:
 *   commands: rebase (run)
 */
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface RebaseScenarioResult {
  readonly runKind: string;
  readonly fileContent: string;
  readonly commitCount: number;
}

export const rebaseScenario: Scenario<RebaseScenarioResult> = {
  name: 'rebase',
  inputs: { files: [{ path: 'base.txt', content: 'base\n' }], author: AUTHOR, message: 'base' },
  expected: {
    runKind: 'rebased',
    fileContent: 'main\n',
    commitCount: 1,
  },
  run: async (repo, inputs) => {
    await repo.init();
    const ctx = repo.ctx;
    await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = R\n\temail = r@x\n');
    await repo.add(['base.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    await repo.branch.create({ name: 'topic' });
    await repo.checkout({ rev: 'topic' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/t.txt`, 'topic\n');
    await repo.add(['t.txt']);
    await repo.commit({ message: 't1', author: inputs.author });

    await repo.checkout({ rev: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'main\n');
    await repo.add(['m.txt']);
    await repo.commit({ message: 'm1', author: inputs.author });
    await repo.checkout({ rev: 'topic' });

    const result = await repo.rebase.run({ upstream: 'main' });
    const fileContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/m.txt`);
    return {
      runKind: result.kind,
      fileContent,
      commitCount: result.kind === 'rebased' ? result.commits.length : -1,
    };
  },
};

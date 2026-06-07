/**
 * Range-diff scenario — seeds a base commit, then two diverging single-commit
 * series (`v1` "old", `v2` "new") that add the same large file with one line
 * changed, so the exact + min-cost assignment, the `=`/`!` status decision, and
 * the diff-of-diffs run identically on Node, memory, and the browser.
 *
 * Surfaces closed:
 *   commands: rangeDiff
 */
import type { AuthorIdentity } from '../../../src/domain/objects/author-identity.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

const big = (changed: string): string => {
  const lines: string[] = [];
  for (let n = 1; n <= 20; n++) lines.push(n === 10 ? changed : `line ${n}`);
  return `${lines.join('\n')}\n`;
};

const at = (offset: number): AuthorIdentity => ({
  ...AUTHOR,
  timestamp: AUTHOR.timestamp + offset,
});

interface RangeDiffScenarioResult {
  readonly entries: ReadonlyArray<{
    readonly status: string;
    readonly oldPosition: number | null;
    readonly newPosition: number | null;
    readonly hasDiffOfDiffs: boolean;
  }>;
}

export const rangeDiffScenario: Scenario<RangeDiffScenarioResult> = {
  name: 'range-diff',
  inputs: {
    files: [{ path: 'seed.txt', content: 'seed\n' }],
    author: AUTHOR,
    message: 'seed commit',
  },
  expected: {
    entries: [{ status: 'changed', oldPosition: 1, newPosition: 1, hasDiffOfDiffs: true }],
  },
  run: async (repo, inputs) => {
    const ctx = repo.ctx;
    await repo.init();
    await repo.add(['seed.txt']);
    const base = await repo.commit({ message: inputs.message, author: at(0) });

    await repo.branch.create({ name: 'v1' });
    await repo.checkout({ rev: 'v1' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/big.txt`, big('ten-old'));
    await repo.add(['big.txt']);
    await repo.commit({ message: 'add big', author: at(60) });

    await repo.checkout({ rev: 'main' });
    await repo.branch.create({ name: 'v2' });
    await repo.checkout({ rev: 'v2' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/big.txt`, big('ten-new'));
    await repo.add(['big.txt']);
    await repo.commit({ message: 'add big', author: at(120) });

    const entries = await repo.rangeDiff({
      old: { base: base.id, tip: 'v1' },
      new: { base: base.id, tip: 'v2' },
    });
    return {
      entries: entries.map((e) => ({
        status: e.status,
        oldPosition: e.old?.position ?? null,
        newPosition: e.new?.position ?? null,
        hasDiffOfDiffs: e.diffOfDiffs !== undefined,
      })),
    };
  },
};

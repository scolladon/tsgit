/**
 * Stash round-trip scenario — `stash.push` saves an unstaged change (clearing
 * the working tree), `stash.list` reports the single stack entry, and
 * `stash.pop` restores the change and empties the stack. Captures only
 * deterministic observable state (working-tree content + stack lengths): the
 * W/I/U commit OIDs embed the committer timestamp and so are not comparable
 * across runs.
 *
 * Surfaces closed:
 *   commands: stash (push/list/pop)
 */
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface StashResult {
  readonly pushKind: string;
  readonly afterPushContent: string;
  readonly listLenAfterPush: number;
  readonly popKind: string;
  readonly afterPopContent: string;
  readonly listLenAfterPop: number;
}

export const stashScenario: Scenario<StashResult> = {
  name: 'stash',
  inputs: { files: [{ path: 'a.txt', content: 'committed\n' }], author: AUTHOR, message: 'seed' },
  expected: {
    pushKind: 'saved',
    afterPushContent: 'committed\n',
    listLenAfterPush: 1,
    popKind: 'applied',
    afterPopContent: 'modified\n',
    listLenAfterPop: 0,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    const ctx = repo.ctx;
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'modified\n');
    const saved = await repo.stash.push();
    const afterPushContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`);
    const listLenAfterPush = (await repo.stash.list()).entries.length;

    const popped = await repo.stash.pop();
    const afterPopContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`);
    const listLenAfterPop = (await repo.stash.list()).entries.length;

    return {
      pushKind: saved.kind,
      afterPushContent,
      listLenAfterPush,
      popKind: popped.kind,
      afterPopContent,
      listLenAfterPop,
    };
  },
};

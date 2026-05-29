/**
 * State-mutating command scenario — `rm` removes a tracked file, then a
 * follow-up commit, then `reset --mixed` walks HEAD back to the seed
 * commit, then `reflog show` reports the chain of moves. Bundles the
 * three commands because they share a multi-step setup.
 *
 * Surfaces closed (per 19.5a):
 *   commands: reset, rm, reflog
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface ResetRmReflogResult {
  readonly seedCommitId: string;
  readonly secondCommitId: string;
  readonly rmRemoved: ReadonlyArray<string>;
  readonly removalCommitId: string;
  readonly resetMode: 'soft' | 'mixed' | 'hard';
  readonly resetTargetId: string;
  readonly reflogKind: string;
  readonly reflogSelectors: ReadonlyArray<string>;
}

export const resetRmReflogScenario: Scenario<ResetRmReflogResult> = {
  name: 'reset-rm-reflog',
  inputs: { files: [FILES.helloA, FILES.helloB], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    seedCommitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    secondCommitId: 'aaf0bbab5773df6abf0967d92199c55c1be97162',
    rmRemoved: ['b.txt'],
    removalCommitId: 'b12331ac0b92d884515b0ed525aef0567a29e12b',
    resetMode: 'mixed',
    resetTargetId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    reflogKind: 'show',
    reflogSelectors: ['HEAD@{0}', 'HEAD@{1}', 'HEAD@{2}', 'HEAD@{3}'],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });
    await repo.add(['b.txt']);
    const second = await repo.commit({ message: MESSAGES.second, author: inputs.author });

    const rmResult = await repo.rm(['b.txt']);
    const removalCommit = await repo.commit({
      message: 'remove b.txt',
      author: inputs.author,
    });

    const resetResult = await repo.reset({ mode: 'mixed', target: seed.id });

    const reflog = await repo.reflog({ action: 'show', ref: 'HEAD' });

    return {
      seedCommitId: seed.id,
      secondCommitId: second.id,
      rmRemoved: rmResult.removed.slice().sort(),
      removalCommitId: removalCommit.id,
      resetMode: resetResult.mode,
      resetTargetId: resetResult.id,
      reflogKind: reflog.kind,
      reflogSelectors: reflog.kind === 'show' ? reflog.entries.map((entry) => entry.selector) : [],
    };
  },
};

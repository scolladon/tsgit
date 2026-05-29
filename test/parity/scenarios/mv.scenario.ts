/**
 * State-mutating command scenario — `mv` renames a tracked file and moves
 * another into an existing directory, then commits the reshaped tree. Locks
 * both the per-move report (`moved`) and the resulting commit id so every
 * adapter (Node / Memory / Browser) produces the byte-identical tree.
 *
 * Surfaces closed: commands: mv
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface MvScenarioResult {
  readonly renameMoved: ReadonlyArray<{ from: string; to: string }>;
  readonly intoDirMoved: ReadonlyArray<{ from: string; to: string }>;
  readonly commitId: string;
  readonly clean: boolean;
}

export const mvScenario: Scenario<MvScenarioResult> = {
  name: 'mv',
  inputs: {
    files: [FILES.helloA, FILES.helloB, { path: 'dir/keep.txt', content: 'keep\n' }],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    renameMoved: [{ from: 'a.txt', to: 'renamed.txt' }],
    intoDirMoved: [{ from: 'b.txt', to: 'dir/b.txt' }],
    // 40-hex golden — Node baseline. Memory and Browser drivers assert the same
    // value; divergence proves a parity bug in the index repath or tree build.
    // The mv'd *tree* is byte-identical to canonical git (verified out-of-band);
    // this commit id is the tsgit cross-adapter baseline.
    commitId: 'ac27f9bfa53da1f6ebe70e23ca2e57e623d3cbdb',
    clean: true,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    const rename = await repo.mv(['a.txt'], 'renamed.txt');
    const intoDir = await repo.mv(['b.txt'], 'dir');
    const commit = await repo.commit({ message: 'after mv', author: inputs.author });
    const status = await repo.status();

    return {
      renameMoved: rename.moved.map((move) => ({ from: move.from, to: move.to })),
      intoDirMoved: intoDir.moved.map((move) => ({ from: move.from, to: move.to })),
      commitId: commit.id,
      clean: status.clean,
    };
  },
};

import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface InitAddCommitStatusResult {
  readonly init: { initialBranch: string; bare: boolean };
  readonly add: { added: ReadonlyArray<string> };
  readonly commit: { id: string; branch: string | undefined };
  readonly status: {
    clean: boolean;
    branch: string | undefined;
    detached: boolean;
    indexChanges: ReadonlyArray<unknown>;
    workingTreeChanges: ReadonlyArray<unknown>;
  };
}

export const initAddCommitStatusScenario: Scenario<InitAddCommitStatusResult> = {
  name: 'init-add-commit-status',
  inputs: {
    files: [FILES.helloA],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    init: { initialBranch: 'refs/heads/main', bare: false },
    add: { added: ['a.txt'] },
    // Commit id is filled in slice 1 once the Node driver runs and emits the
    // real SHA-1. Placeholder until then — the first run intentionally fails
    // with a golden mismatch that prints the actual value.
    commit: { id: '0000000000000000000000000000000000000000', branch: 'refs/heads/main' },
    status: {
      clean: true,
      branch: 'refs/heads/main',
      detached: false,
      indexChanges: [],
      workingTreeChanges: [],
    },
  },
  run: async (repo, inputs) => {
    const init = await repo.init();
    const add = await repo.add(inputs.files.map((file) => file.path));
    const commit = await repo.commit({ message: inputs.message, author: inputs.author });
    const status = await repo.status();
    return {
      init: { initialBranch: init.initialBranch, bare: init.bare },
      add: { added: add.added.slice() },
      commit: { id: commit.id, branch: commit.branch },
      status: {
        clean: status.clean,
        branch: status.branch,
        detached: status.detached,
        indexChanges: status.indexChanges,
        workingTreeChanges: status.workingTreeChanges,
      },
    };
  },
};

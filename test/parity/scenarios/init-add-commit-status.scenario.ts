import type { ChangeEntry } from '../../../src/application/commands/status.ts';
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
    indexChanges: ReadonlyArray<ChangeEntry>;
    workingTreeChanges: ReadonlyArray<ChangeEntry>;
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
    init: { initialBranch: 'main', bare: false },
    add: { added: ['a.txt'] },
    // 40-hex golden — Node baseline. Memory and Browser drivers assert the
    // same value; divergence proves a parity bug in object serialization,
    // hash framing, or author identity encoding (ADR-128).
    commit: { id: 'fa8b886eee0d470d870e786878657cac05d686e6', branch: 'refs/heads/main' },
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
        // Defensive copies — the underlying StatusResult arrays are
        // readonly but `.slice()` keeps the parity object self-contained
        // and immune to any future repo-internal mutation across scenarios.
        indexChanges: status.indexChanges.slice(),
        workingTreeChanges: status.workingTreeChanges.slice(),
      },
    };
  },
};

import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface BranchInfoLite {
  readonly name: string;
  readonly id: string;
  readonly current: boolean;
}

interface BranchLifecycleResult {
  readonly seedCommitId: string;
  readonly created: { name: string; id: string };
  readonly listAfterCreate: ReadonlyArray<BranchInfoLite>;
  readonly deleted: { name: string };
  readonly listAfterDelete: ReadonlyArray<BranchInfoLite>;
}

export const branchLifecycleScenario: Scenario<BranchLifecycleResult> = {
  name: 'branch-lifecycle',
  inputs: {
    files: [FILES.helloA],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    seedCommitId: '87863a6f57aeedd577100911fadbc21ff1062bec',
    created: {
      name: 'refs/heads/feature',
      id: '87863a6f57aeedd577100911fadbc21ff1062bec',
    },
    listAfterCreate: [
      {
        name: 'refs/heads/feature',
        id: '87863a6f57aeedd577100911fadbc21ff1062bec',
        current: false,
      },
      {
        name: 'refs/heads/main',
        id: '87863a6f57aeedd577100911fadbc21ff1062bec',
        current: true,
      },
    ],
    deleted: { name: 'refs/heads/feature' },
    listAfterDelete: [
      {
        name: 'refs/heads/main',
        id: '87863a6f57aeedd577100911fadbc21ff1062bec',
        current: true,
      },
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });
    const created = await repo.branch.create({ name: 'feature' });
    const listAfterCreate = await repo.branch.list();
    const deleted = await repo.branch.delete({ name: 'feature' });
    const listAfterDelete = await repo.branch.list();
    return {
      seedCommitId: seed.id,
      created: { name: created.name, id: created.id },
      listAfterCreate: listAfterCreate.branches.map((info) => ({
        name: info.name,
        id: info.id,
        current: info.current,
      })),
      deleted: { name: deleted.name },
      listAfterDelete: listAfterDelete.branches.map((info) => ({
        name: info.name,
        id: info.id,
        current: info.current,
      })),
    };
  },
};

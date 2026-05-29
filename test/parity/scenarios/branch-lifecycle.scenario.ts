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
    seedCommitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    created: {
      name: 'refs/heads/feature',
      id: 'fa8b886eee0d470d870e786878657cac05d686e6',
    },
    listAfterCreate: [
      {
        name: 'refs/heads/feature',
        id: 'fa8b886eee0d470d870e786878657cac05d686e6',
        current: false,
      },
      {
        name: 'refs/heads/main',
        id: 'fa8b886eee0d470d870e786878657cac05d686e6',
        current: true,
      },
    ],
    deleted: { name: 'refs/heads/feature' },
    listAfterDelete: [
      {
        name: 'refs/heads/main',
        id: 'fa8b886eee0d470d870e786878657cac05d686e6',
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

/**
 * Bench: `repo.branch.list()` over loose branches. In-process scratch
 * repository built with tsgit's own primitives (never `git`, never the
 * shared tiered cache): a single-commit base repo, then N-1 more loose
 * branches written directly through the `Context` — no `packRefs`, so
 * every branch stays a loose file. One row: 1 000 loose branches total.
 */
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import { openRepository, type Repository } from '../../src/index.node.js';
import { setupSmallRepo, writeManyRefs } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

const BRANCH_COUNT = 1_000;
// setupSmallRepo's own commit already lands on one loose branch; the fixture
// adds the rest so branch.list() sees exactly BRANCH_COUNT.
const EXTRA_BRANCHES = BRANCH_COUNT - 1;

interface LooseBranchesFixture {
  readonly cwd: string;
  readonly repo: Repository;
}

const setupLooseBranchesFixture = async (): Promise<LooseBranchesFixture> => {
  const base = await setupSmallRepo({ commits: 1 });
  const ctx = createNodeContext({ workDir: base.cwd, hooks: false, command: false, ssh: false });
  await writeManyRefs(
    ctx,
    EXTRA_BRANCHES,
    (index) => `refs/heads/bench-branch-${index}` as RefName,
    base.headCommitId as ObjectId,
  );
  const repo = await openRepository({ cwd: base.cwd });
  return { cwd: base.cwd, repo };
};

benchScenario(
  `Given a repository with ${BRANCH_COUNT} loose branches`,
  `When branch.list() lists ${BRANCH_COUNT} loose branches, Then measure tsgit`,
  async () => {
    const fixture = await setupLooseBranchesFixture();
    return {
      teardown: async (): Promise<void> => {
        removeSync(fixture.cwd);
        await fixture.repo.dispose();
      },
      sut: async (): Promise<void> => {
        await fixture.repo.branch.list();
      },
    };
  },
);

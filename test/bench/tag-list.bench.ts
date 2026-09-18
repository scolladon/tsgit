/**
 * Bench: `repo.tag.list()` over packed tags. In-process scratch repository
 * built with tsgit's own primitives (never `git`, never the shared tiered
 * cache — the 31.1 `name-rev.bench` many-tag pattern): a small base repo,
 * then N lightweight tags written directly through the `Context`, then
 * `repo.packRefs()` so every tag is packed-only. Two rows scale the packed
 * read: 2 000 and 10 000 tags.
 */
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import { openRepository, type Repository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { setupSmallRepo, writeManyRefs } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

const TAGS_DIR = 'refs/tags';

interface PackedTagsFixture {
  readonly cwd: string;
  readonly repo: Repository;
}

/**
 * The whole point of this fixture: a tag row measures the packed-refs read
 * only if packing actually left no loose file behind. Throwing here (rather
 * than silently measuring the loose path) keeps a regression in `packRefs`
 * from turning into a misleading "packed" measurement.
 */
const assertTagsPackedOnly = async (ctx: Context): Promise<void> => {
  const dir = `${ctx.layout.gitDir}/${TAGS_DIR}`;
  if (!(await ctx.fs.exists(dir))) return;
  const entries = await ctx.fs.readdir(dir);
  if (entries.length > 0) {
    throw new Error(`tag-list fixture: ${entries.length} loose tag(s) survived packRefs()`);
  }
};

const setupPackedTagsFixture = async (tagCount: number): Promise<PackedTagsFixture> => {
  const base = await setupSmallRepo();
  const ctx = createNodeContext({ workDir: base.cwd, hooks: false, command: false, ssh: false });
  await writeManyRefs(
    ctx,
    tagCount,
    (index) => `refs/tags/bench-tag-${index}` as RefName,
    base.headCommitId as ObjectId,
  );
  const repo = await openRepository({ cwd: base.cwd });
  await repo.packRefs();
  await assertTagsPackedOnly(ctx);
  return { cwd: base.cwd, repo };
};

const tagListScenario = (tagCount: number): void => {
  benchScenario(
    `Given a repository with ${tagCount} packed tags`,
    `When tag.list() lists ${tagCount} packed tags, Then measure tsgit`,
    async () => {
      const fixture = await setupPackedTagsFixture(tagCount);
      return {
        teardown: async (): Promise<void> => {
          removeSync(fixture.cwd);
          await fixture.repo.dispose();
        },
        sut: async (): Promise<void> => {
          await fixture.repo.tag.list();
        },
      };
    },
  );
};

tagListScenario(2_000);
tagListScenario(10_000);

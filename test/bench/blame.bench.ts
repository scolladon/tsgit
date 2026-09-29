/**
 * Tiered bench: `repo.blame()` on a file that is unchanged across a deep
 * ancestry (a sibling file churns every commit instead). Pins the
 * O(path-depth) descent + TREESAME skip win at each fixture tier — tsgit-only,
 * no isomorphic-git baseline (this measures tsgit-vs-tsgit across branches,
 * not vs isomorphic-git).
 *
 * A second, in-memory scenario below measures the OPPOSITE shape: a file
 * that changes on every hop, so every generation actually diffs (and, before
 * the hop-to-hop hash cache, re-hashes the shared blob twice).
 */
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { blame } from '../../src/application/commands/blame.js';
import { commit } from '../../src/application/commands/commit.js';
import { init } from '../../src/application/commands/init.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { benchScenario } from './support/bench-dsl.js';
import { makeXorshift32 } from './support/fixture-generator.js';
import { DEEP_ANCESTRY_TIERS, tieredScenario } from './support/tiered-bench.js';

await tieredScenario(
  DEEP_ANCESTRY_TIERS,
  'When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });

    return {
      teardown: () => repo.dispose(),
      sut: async (): Promise<void> => {
        await repo.blame('stable.txt');
      },
    };
  },
);

const CHURNING_LINE_COUNT = 5_000;
const CHURNING_COMMIT_COUNT = 50;
const CHURNING_EDITS_PER_COMMIT = 3;
const CHURNING_BASE_SEED = 50;
const CHURNING_EDIT_SEED = 51;
const CHURN_PATH = 'churn.txt';
let churnTimestamp = 1_700_000_000;

const churningIdentity = (): AuthorIdentity => {
  churnTimestamp += 60;
  return {
    name: 'churner',
    email: 'churner@example.com',
    timestamp: churnTimestamp,
    timezoneOffset: '+0000',
  };
};

/** `count` lines of high-entropy, reproducible text — mirrors `line-diff.bench.ts`'s generator. */
const buildLines = (count: number, seed: number): string[] => {
  const next = makeXorshift32(seed);
  return Array.from({ length: count }, (_, i) => `line ${i} ${next().toString(16)}\n`);
};

/** Rewrites `editCount` pseudo-random lines in place, advancing `next` — one commit's worth of churn. */
const applyScatteredEdits = (lines: string[], editCount: number, next: () => number): void => {
  for (let i = 0; i < editCount; i += 1) {
    const index = next() % lines.length;
    lines[index] = `edited ${index} ${next().toString(16)}\n`;
  }
};

/** Commits `lines` as `churn.txt`'s content, then rewrites a few of its lines in place for the next call. */
const commitAndChurn = async (
  ctx: Context,
  lines: string[],
  editNext: () => number,
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${CHURN_PATH}`, lines.join(''));
  await add(ctx, [CHURN_PATH]);
  const identity = churningIdentity();
  await commit(ctx, { message: 'churn', author: identity, committer: identity });
  applyScatteredEdits(lines, CHURNING_EDITS_PER_COMMIT, editNext);
};

benchScenario(
  `Given ${CHURN_PATH} changing across ${CHURNING_COMMIT_COUNT} commits (${CHURNING_EDITS_PER_COMMIT} lines each) over ${CHURNING_LINE_COUNT} lines`,
  'When blame() walks every hop end-to-end, Then measure tsgit',
  async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    const lines = buildLines(CHURNING_LINE_COUNT, CHURNING_BASE_SEED);
    const editNext = makeXorshift32(CHURNING_EDIT_SEED);
    for (let i = 0; i < CHURNING_COMMIT_COUNT; i += 1) {
      await commitAndChurn(ctx, lines, editNext);
    }

    return {
      sut: async (): Promise<void> => {
        await blame(ctx, CHURN_PATH);
      },
    };
  },
);

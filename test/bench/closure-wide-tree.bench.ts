/**
 * Bench: the wide-tree shape the prune actually pays off on. Every commit in
 * this fixture rewrites exactly one file in one of 40 directories, so only
 * that directory's subtree (plus the root) genuinely changed — a closure
 * walk that re-descends every subtree on every commit pays for the other 39
 * unchanged directories too. `computeClosure({ tier: 'walk' })` is measured
 * directly (never through a command default) at two history lengths so the
 * per-commit slope itself is visible: both trees scale with commit count —
 * linear with a small slope, not flat — since the root and the one changed
 * subtree are genuine per-commit work in git too.
 */
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { computeClosure } from '../../src/application/primitives/internal/closure-engine.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { setupWideTreeClosureFixture, type WideTreeClosureFixture } from './fixtures.js';
import type { BenchComparison } from './support/bench-dsl.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

const wideTreeComparison = (commits: number) => async (): Promise<BenchComparison> => {
  const fixture: WideTreeClosureFixture = await setupWideTreeClosureFixture(commits);
  const repo = await openRepository({ cwd: fixture.cwd });
  const ctx = createNodeContext({ workDir: fixture.cwd, hooks: false, command: false, ssh: false });

  return {
    teardown: async (): Promise<void> => {
      removeSync(fixture.cwd);
      await repo.dispose();
    },
    sut: async (): Promise<void> => {
      await computeClosure(ctx, {
        wants: [fixture.headCommitId as ObjectId],
        not: [],
        objects: true,
        tier: 'walk',
      });
    },
  };
};

benchScenario(
  'Given a wide tree of 40 directories × 50 files across a 100-commit history rewriting one file per commit',
  "When computeClosure({ objects: true, tier: 'walk' }) walks the full objects closure, Then measure tsgit",
  wideTreeComparison(100),
);

benchScenario(
  'Given a wide tree of 40 directories × 50 files across a 300-commit history rewriting one file per commit',
  "When computeClosure({ objects: true, tier: 'walk' }) walks the full objects closure, Then measure tsgit",
  wideTreeComparison(300),
);

/**
 * Bench: the `maintenance` command's two tasks.
 *
 * `commit-graph` is measured over the medium scaled fixture's commit count
 * (Part 2's driver). `gc` gets three scenarios: a plain write over freshly
 * seeded reachable loose objects (fresh-per-iteration, `write-scratch.ts`'s
 * model — a gc mutates the store, so it cannot loop in place any more than
 * `commit` can); a REPEAT run over unreachable loose objects already folded
 * into a cruft pack (the carry-forward cost a first-run number would hide);
 * and a REPEAT run over the deep-delta-chain fixture — the design's cost
 * ceiling now that `buildPack` deltifies, since there is no "already
 * consolidated, skip it" branch (Pin W), so every run re-walks the window
 * and re-selects delta bases from scratch.
 *
 * The OPPOSITE cost ceiling — the window search's wasted-encode overhead
 * when every candidate loses (unrelated blob content, none of them beats
 * its own base entry) — is priced separately in `deltify.bench.ts` as a
 * direct micro-bench over `deltifyEntries`, not a full gc: a full-gc
 * version of that scenario over the medium fixture's 35 003 objects ran
 * ~7-8 minutes for tinybench's default 5 warmup + 10 measured iterations,
 * against `bench.yml`'s 30-minute budget for the WHOLE suite, and mixed
 * enumerate/read/deflate/pack-write cost into the search signal it meant
 * to isolate.
 *
 * The two REPEAT scenarios remaining here build their fixture, and any
 * pre-existing cruft pack, ONCE and then let `bench()`'s own repeated `sut`
 * calls exercise the steady state — resetting between iterations would
 * measure the reset, not gc. Both scaled scenarios (`commit-graph`,
 * delta-chain) copy the SHARED, cached fixture into a scratch directory
 * first: `gc` retires and rewrites packs in place, and the cache is reused,
 * byte-for-byte, by every other bench file that resolves the same spec.
 * Cleanup rides on the scenario's `teardown`, the one hook `vitest bench`
 * actually runs — an `afterAll` here never fires.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { maintenance } from '../../src/application/commands/maintenance.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { benchScenario } from './support/bench-dsl.js';
import {
  DELTA_CHAIN_FIXTURE,
  MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
} from './support/fixture-generator.js';
import { copyFixtureToScratch } from './support/fixture-scratch.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';
import { buildManyLooseObjectsScratch } from './support/write-scratch.js';

const enc = new TextEncoder();

// ---------------------------------------------------------------------
// Scenario 1 — commit-graph write, over the medium fixture's commit count
// ---------------------------------------------------------------------

const commitGraphCtx = await resolveScaledContext(MEDIUM_FIXTURE_WITH_COMMIT_GRAPH);

scaledScenario(
  commitGraphCtx,
  "When maintenance({tasks:['commit-graph']}) writes the graph, Then measure tsgit",
  async (fixture) => {
    const scratch = await copyFixtureToScratch(fixture.cwd);
    const ctx = createNodeContext({
      workDir: scratch.cwd,
      hooks: false,
      command: false,
      ssh: false,
    });

    const sut = async (): Promise<void> => {
      await maintenance(ctx, { tasks: ['commit-graph'] });
    };
    return {
      sut,
      teardown: (): void => {
        scratch.disposeSync();
      },
    };
  },
);

// ---------------------------------------------------------------------
// Scenario 2 — gc over freshly seeded reachable loose objects (fresh
// per-iteration; a gc mutates the store, so it cannot loop in place)
// ---------------------------------------------------------------------

const MANY_LOOSE_OBJECT_COUNT = 3_000;

benchScenario(
  `Given a freshly built scratch repo with ${MANY_LOOSE_OBJECT_COUNT} reachable loose objects`,
  "When maintenance({tasks:['gc']}) repacks them, Then measure tsgit",
  () => {
    const scratchDirs: string[] = [];

    const sut = async (): Promise<void> => {
      const scratch = await buildManyLooseObjectsScratch(MANY_LOOSE_OBJECT_COUNT);
      scratchDirs.push(scratch.cwd);
      await scratch.repo.maintenance({ tasks: ['gc'] });
      await scratch.repo.dispose();
    };
    return {
      sut,
      teardown: async (): Promise<void> => {
        await Promise.all(scratchDirs.map((cwd) => rm(cwd, { recursive: true, force: true })));
      },
    };
  },
);

// ---------------------------------------------------------------------
// Scenario 3 — REPEAT gc over unreachable loose objects already folded
// into an existing cruft pack
// ---------------------------------------------------------------------

const MANY_UNREACHABLE_OBJECT_COUNT = 3_000;

benchScenario(
  `Given ${MANY_UNREACHABLE_OBJECT_COUNT} unreachable loose objects already folded into an existing cruft pack`,
  "When maintenance({tasks:['gc']}) repeats, Then measure tsgit",
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-maintenance-cruft-'));
    const { openRepository } = await import('../../src/index.node.js');
    const bootstrap = await openRepository({ cwd });
    await bootstrap.init();
    await bootstrap.dispose();

    const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
    await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[gc]\n\tpruneExpire = never\n');
    for (let i = 0; i < MANY_UNREACHABLE_OBJECT_COUNT; i += 1) {
      await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: enc.encode(`garbage payload ${i}`),
      });
    }
    // Folds every unreachable blob into one cruft pack — the "existing cruft
    // pack" precondition; every later sut() call is then a genuine repeat.
    await maintenance(ctx, { tasks: ['gc'] });

    const sut = async (): Promise<void> => {
      await maintenance(ctx, { tasks: ['gc'] });
    };
    return {
      sut,
      teardown: async (): Promise<void> => {
        await rm(cwd, { recursive: true, force: true });
      },
    };
  },
);

// ---------------------------------------------------------------------
// Scenario 4 — REPEAT gc over the deep-delta-chain fixture; the design's
// cost ceiling now that `buildPack` deltifies (no skip branch, the window
// re-walks and re-selects delta bases every run)
// ---------------------------------------------------------------------

const deltaChainCtx = await resolveScaledContext(DELTA_CHAIN_FIXTURE);

scaledScenario(
  deltaChainCtx,
  "When maintenance({tasks:['gc']}) repeats over an already-consolidated repository, Then measure tsgit and report the size-trade ratio",
  async (fixture) => {
    const scratch = await copyFixtureToScratch(fixture.cwd);
    const ctx = createNodeContext({
      workDir: scratch.cwd,
      hooks: false,
      command: false,
      ssh: false,
    });

    // First run: consolidates the fixture's git-deltified pack(s) into
    // tsgit's own deltified one, and is the one place this budget is
    // reported — a console line, never a threshold: the ratio moves
    // with the corpus, so asserting it here would be a flake generator.
    const first = await maintenance(ctx, { tasks: ['gc'] });
    if (first.packBytesBefore > 0) {
      const ratio = first.packBytesAfter / first.packBytesBefore;
      console.log(
        `[maintenance.bench] delta-chain size-trade (packBytesAfter / packBytesBefore): ${ratio.toFixed(2)}x`,
      );
    }

    const sut = async (): Promise<void> => {
      await maintenance(ctx, { tasks: ['gc'] });
    };
    return {
      sut,
      teardown: (): void => {
        scratch.disposeSync();
      },
    };
  },
);

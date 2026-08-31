/**
 * Bench: the `maintenance` command's two tasks.
 *
 * `commit-graph` is measured over the medium scaled fixture's commit count
 * (Part 2's driver). `gc` gets four scenarios: a plain write over freshly
 * seeded reachable loose objects (fresh-per-iteration, `write-scratch.ts`'s
 * model — a gc mutates the store, so it cannot loop in place any more than
 * `commit` can); a REPEAT run over unreachable loose objects already folded
 * into a cruft pack (the carry-forward cost a first-run number would hide);
 * a REPEAT run over the deep-delta-chain fixture — the design's cost
 * ceiling now that `buildPack` deltifies, since there is no "already
 * consolidated, skip it" branch (Pin W), so every run re-walks the window
 * and re-selects delta bases from scratch; and a REPEAT run over the
 * medium fixture's barely-deltifiable shape (unrelated blob content per
 * commit), which bounds the OPPOSITE cost — every candidate the window
 * offers is a thrown-away encode, since none of them beats its own base
 * entry, so this scenario prices the search's overhead when it finds
 * nothing to keep.
 *
 * The three REPEAT scenarios build their fixture, and any pre-existing
 * cruft pack, ONCE and then let `bench()`'s own repeated `sut` calls
 * exercise the steady state — resetting between iterations would measure
 * the reset, not gc. All three scaled scenarios (`commit-graph`,
 * delta-chain, medium) copy the SHARED, cached fixture into a scratch
 * directory first: `gc` retires and rewrites packs in place, and the
 * cache is reused, byte-for-byte, by every other bench file that resolves
 * the same spec.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll } from 'vitest';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { maintenance } from '../../src/application/commands/maintenance.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { benchScenario } from './support/bench-dsl.js';
import {
  DELTA_CHAIN_FIXTURE,
  MEDIUM_FIXTURE,
  MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
} from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';
import { buildManyLooseObjectsScratch } from './support/write-scratch.js';

const enc = new TextEncoder();

/** Copies a cached scaled fixture into a disposable scratch directory — `gc`
 *  retires and rewrites packs in place, and the cache must stay pristine for
 *  every other bench file that resolves the same spec. */
async function copyToScratch(sourceCwd: string, slug: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `tsgit-bench-maintenance-${slug}-`));
  await cp(sourceCwd, cwd, { recursive: true, preserveTimestamps: true });
  return cwd;
}

// ---------------------------------------------------------------------
// Scenario 1 — commit-graph write, over the medium fixture's commit count
// ---------------------------------------------------------------------

const commitGraphCtx = await resolveScaledContext(MEDIUM_FIXTURE_WITH_COMMIT_GRAPH);

scaledScenario(
  commitGraphCtx,
  "When maintenance({tasks:['commit-graph']}) writes the graph, Then measure tsgit",
  async (fixture) => {
    const cwd = await copyToScratch(fixture.cwd, 'commit-graph');
    const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
    afterAll(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    const sut = async (): Promise<void> => {
      await maintenance(ctx, { tasks: ['commit-graph'] });
    };
    return { sut };
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
    afterAll(async () => {
      await Promise.all(scratchDirs.map((cwd) => rm(cwd, { recursive: true, force: true })));
    });

    const sut = async (): Promise<void> => {
      const scratch = await buildManyLooseObjectsScratch(MANY_LOOSE_OBJECT_COUNT);
      scratchDirs.push(scratch.cwd);
      await scratch.repo.maintenance({ tasks: ['gc'] });
      await scratch.repo.dispose();
    };
    return { sut };
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

    afterAll(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    const sut = async (): Promise<void> => {
      await maintenance(ctx, { tasks: ['gc'] });
    };
    return { sut };
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
    const cwd = await copyToScratch(fixture.cwd, 'delta-chain');
    const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
    afterAll(async () => {
      await rm(cwd, { recursive: true, force: true });
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
    return { sut };
  },
);

// ---------------------------------------------------------------------
// Scenario 5 — REPEAT gc over the medium fixture's barely-deltifiable
// shape; the OPPOSITE cost ceiling to scenario 4 (every window candidate
// is a thrown-away encode, since none of them beats its own base entry)
// ---------------------------------------------------------------------

const mediumCtx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(
  mediumCtx,
  "When maintenance({tasks:['gc']}) repeats over an already-consolidated, barely-deltifiable repository, Then measure tsgit's wasted search cost",
  async (fixture) => {
    const cwd = await copyToScratch(fixture.cwd, 'medium-barely-deltifiable');
    const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
    afterAll(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    // First run: folds the fixture's unrelated-per-commit blobs into one
    // pack — every later sut() call then re-runs the window search over
    // a set where almost nothing wins, pricing the search itself rather
    // than the encode-and-keep path scenario 4 measures.
    await maintenance(ctx, { tasks: ['gc'] });

    const sut = async (): Promise<void> => {
      await maintenance(ctx, { tasks: ['gc'] });
    };
    return { sut };
  },
);

/**
 * Bench: the bitmap closure a caller actually pays for through each
 * command's own default — `revList()` walks (git's own default for
 * `rev-list`), `packObjects()` prefers a usable bitmap (git's own default
 * for `pack-objects --revs`) — over the SAME bitmap-covered repository.
 * Neither call forces the other command's tier onto itself: each
 * scenario's number is what a caller pays by choosing that command, not
 * the closure engine's two tiers measured in isolation.
 *
 * The `.rev` accelerator itself is not measured here — Part 6 already
 * priced it, immediately after it landed.
 */
import { rm } from 'node:fs/promises';
import * as path from 'node:path';

import { afterAll } from 'vitest';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { computeClosure } from '../../src/application/primitives/internal/closure-engine.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import type { Repository } from '../../src/index.node.js';
import { openRepository } from '../../src/index.node.js';
import { type BitmapClosureFixture, setupBitmapClosureFixture } from './fixtures.js';
import type { BenchComparison } from './support/bench-dsl.js';
import { benchScenario } from './support/bench-dsl.js';

/** Comfortably at-or-above the closure design's own 400-commit pinning scale. */
const CLOSURE_FIXTURE_COMMITS = 500;

/**
 * Confirms, from `computeClosure`'s own tier report — the one observable
 * that distinguishes "answered by the bitmap" from "silently fell back to
 * the walk" — that the bitmap tier truly answers this fixture's closure.
 * Runs once at fixture setup, never inside a measured `sut`: a fixture
 * whose bitmap silently degrades to the walk would make both scenarios
 * below measure the identical code path, turning the comparison into a
 * tautology. `objects: true` mirrors `packObjects`' own request shape —
 * tier selection does not depend on `objects`, so this single check covers
 * `revList`'s narrower default too.
 */
async function assertClosureAnsweredByBitmap(fixture: BitmapClosureFixture): Promise<void> {
  const ctx = createNodeContext({ workDir: fixture.cwd, hooks: false, command: false, ssh: false });
  const result = await computeClosure(ctx, {
    wants: [fixture.headCommitId as ObjectId],
    not: [],
    objects: true,
    tier: 'bitmap',
  });
  if (result.tier !== 'bitmap') {
    throw new Error(
      'bitmap-closure fixture: the bitmap tier fell back to the walk — both scenarios would measure the same code',
    );
  }
}

const closureComparison =
  (buildSut: (repo: Repository, headCommitId: string, cwd: string) => () => Promise<void>) =>
  async (): Promise<BenchComparison> => {
    const fixture = await setupBitmapClosureFixture(CLOSURE_FIXTURE_COMMITS);
    await assertClosureAnsweredByBitmap(fixture);

    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
      await fixture.cleanup();
    });

    return { sut: buildSut(repo, fixture.headCommitId, fixture.cwd) };
  };

benchScenario(
  `Given a ${CLOSURE_FIXTURE_COMMITS}-commit repository with a healthy bitmap`,
  'When revList() computes the closure at its own default (a walk), Then measure tsgit',
  closureComparison((repo, headCommitId) => async () => {
    await repo.revList({ wants: [headCommitId] });
  }),
);

benchScenario(
  `Given a ${CLOSURE_FIXTURE_COMMITS}-commit repository with a healthy bitmap`,
  'When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit',
  closureComparison((repo, headCommitId, cwd) => {
    // packObjects writes a content-addressed `.pack`/`.idx` pair and refuses
    // to overwrite an existing one — same wants, same tier, same bytes, same
    // name every call. Clearing the output directory first (mirroring
    // commit.bench.ts's own accepted "mutate, so build inside sut" model)
    // keeps every measured call identical instead of only the first one
    // succeeding and every later one refusing on FILE_EXISTS.
    const outputDirectory = path.join(cwd, 'bench-pack-out');
    return async () => {
      await rm(outputDirectory, { recursive: true, force: true });
      await repo.packObjects({ wants: [headCommitId], outputDirectory });
    };
  }),
);

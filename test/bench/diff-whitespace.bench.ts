/**
 * Bench: `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true,
 * ignoreWhitespace:'all' })` — the whitespace-normalized diff path, tsgit-only
 * (no isomorphic-git `ignoreWhitespace` analog).
 *
 * The two "whitespace-only-modified pairs" scenarios below are the ones that
 * actually reach the whitespace drop-pass predicate: they build a scratch
 * repo of many small files, commit them, rewrite every file whitespace-only,
 * and commit again, so `HEAD~1..HEAD` is all `modify` changes. Loose and
 * packed variants exercise different object-resolution arms.
 *
 * The MEDIUM_FIXTURE scenario below is kept as a non-regression watch on the
 * plain recursive-diff path under `ignoreWhitespace`, **not** as a measure of
 * the predicate: MEDIUM_FIXTURE's build strategy writes brand-new paths on
 * every commit, so `HEAD~1..HEAD` is all `add` changes, and the drop pass
 * returns before ever streaming a blob to compare — confirmed by spying on
 * the predicate across a full run of this scenario and observing zero calls.
 * `recursive:true` is required here regardless: MEDIUM_FIXTURE's default
 * (non-recursive) top-level diff surfaces a directory-oid `modify` change for
 * the shard whose contents changed (git-faithful `diff-tree`-without-`-r`
 * shape — see `diff-trees.test.ts`, "recursive is absent (default) and a
 * sub-directory changes"), which `recursive:true` fully explodes to
 * blob-level changes instead.
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { benchScenario } from './support/bench-dsl.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';
import { buildWhitespacePairsScratch, type ScratchRepo } from './support/write-scratch.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(
  ctx,
  "When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit",
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true, ignoreWhitespace: 'all' });
    };
    return { sut };
  },
);

benchScenario(
  'Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed)',
  "When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit",
  async () => {
    const scratch = await buildWhitespacePairsScratch();
    afterAll(async () => {
      await scratch.dispose();
    });

    const sut = async (): Promise<void> => {
      await scratch.repo.diff({
        from: 'HEAD~1',
        to: 'HEAD',
        recursive: true,
        ignoreWhitespace: 'all',
      });
    };
    return { sut };
  },
);

const resolvePackedScratch = async (): Promise<{ readonly scratch?: ScratchRepo }> => {
  try {
    return { scratch: await buildWhitespacePairsScratch({ packed: true }) };
  } catch {
    return {};
  }
};

const packedScratchCtx = await resolvePackedScratch();

benchScenario(
  'Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`',
  "When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit",
  () => {
    const scratch = packedScratchCtx.scratch;
    if (scratch === undefined) throw new Error('packed whitespace-pairs scratch unavailable');
    afterAll(async () => {
      await scratch.dispose();
    });

    const sut = async (): Promise<void> => {
      await scratch.repo.diff({
        from: 'HEAD~1',
        to: 'HEAD',
        recursive: true,
        ignoreWhitespace: 'all',
      });
    };
    return { sut };
  },
  { skip: packedScratchCtx.scratch === undefined },
);

/**
 * Bench: `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true,
 * ignoreWhitespace:'all' })` — the whitespace-normalized diff path, tsgit-only
 * (no isomorphic-git `ignoreWhitespace` analog). Target: within ~2x of
 * `diff-recursive.bench.ts`'s plain-recursive number on the same fixture,
 * flat memory.
 *
 * `recursive:true` is required here: MEDIUM_FIXTURE's default (non-recursive)
 * top-level diff surfaces a directory-oid `modify` change for the shard whose
 * contents changed (git-faithful `diff-tree`-without-`-r` shape — see
 * `diff-trees.test.ts`, "recursive is absent (default) and a sub-directory
 * changes"), which the whitespace drop-pass predicate cannot stream as blob
 * content. `recursive:true` fully explodes the diff to blob-level changes,
 * the shape the predicate is designed for — the same pairing the unit suite
 * already exercises ("recursive:true and ignoreWhitespace:all").
 */
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(
  ctx,
  "When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit",
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

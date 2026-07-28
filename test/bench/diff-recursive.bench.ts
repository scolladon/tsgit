/**
 * Bench: `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true })` — the
 * recursive/megarepo tree-diff hot loop, tsgit-only (no isomorphic-git
 * recursive-diff analog in the suite). Also benches the wide-tree case: the
 * empty tree against `HEAD`, where every entry differs and the merge-join
 * must walk the entire fixture tree rather than pruning most of it via
 * TREESAME.
 */
import { afterAll } from 'vitest';
import { EMPTY_TREE_OID } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { MEDIUM_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const ctx = await resolveScaledContext(MEDIUM_FIXTURE);

scaledScenario(
  ctx,
  'When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true });
    };
    return { sut };
  },
);

scaledScenario(
  ctx,
  'When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
    });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: EMPTY_TREE_OID, to: 'HEAD', recursive: true });
    };
    return { sut };
  },
);

/**
 * Grep scenario — seeds a single committed blob whose second line contains the
 * pattern "hello parity", then runs `repo.grep` with a regex pattern so the
 * result (matched path, hit line number, span count) runs identically on Node,
 * memory, and browser adapters.
 *
 * Parity proves CROSS-ADAPTER consistency, NOT git faithfulness — the interop
 * slice pins faithfulness against real `git grep`.
 *
 * Surfaces closed:
 *   commands: grep
 */
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface GrepScenarioResult {
  readonly paths: ReadonlyArray<{
    readonly path: string;
    readonly lineNumbers: ReadonlyArray<number>;
    readonly spanCounts: ReadonlyArray<number>;
  }>;
}

const SEED_FILE = { path: 'seed.txt', content: 'first line\nhello parity\nthird line\n' } as const;

export const grepScenario: Scenario<GrepScenarioResult> = {
  name: 'grep',
  inputs: {
    files: [SEED_FILE],
    author: AUTHOR,
    message: 'seed commit',
  },
  expected: {
    paths: [{ path: SEED_FILE.path, lineNumbers: [2], spanCounts: [1] }],
  },
  run: async (repo, inputs) => {
    // Arrange
    await repo.init();
    await repo.add([SEED_FILE.path]);
    await repo.commit({ message: inputs.message, author: inputs.author });

    // Act — default (working-tree) target; file is tracked so all adapters find it
    const result = await repo.grep({ patterns: [/hello parity/] });

    // Assert — project to a stable, adapter-independent shape
    return {
      paths: result.paths.map((p) => ({
        path: p.path,
        lineNumbers: p.hits.map((h) => h.lineNumber),
        spanCounts: p.hits.map((h) => h.spans.length),
      })),
    };
  },
};

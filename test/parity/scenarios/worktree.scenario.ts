/**
 * Worktree scenario — seeds a single commit, adds a linked worktree under the
 * repo root (so the in-memory/browser sandboxes can reach it), then lists the
 * worktrees. The structured branch/detached/main fields must match across Node,
 * memory, and the browser; absolute paths are adapter-specific and excluded.
 *
 * Surfaces closed:
 *   commands: worktree
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface WorktreeScenarioResult {
  readonly added: { readonly branch: string | undefined; readonly detached: boolean };
  readonly list: ReadonlyArray<{
    readonly branch: string | undefined;
    readonly detached: boolean;
    readonly main: boolean;
  }>;
}

export const worktreeScenario: Scenario<WorktreeScenarioResult> = {
  name: 'worktree',
  inputs: {
    files: [FILES.helloA],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    added: { branch: 'refs/heads/wt', detached: false },
    list: [
      { branch: 'refs/heads/main', detached: false, main: true },
      { branch: 'refs/heads/wt', detached: false, main: false },
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: 'seed commit', author: inputs.author });

    const added = await repo.worktree.add({ path: 'wt' });
    const list = await repo.worktree.list();
    return {
      added: { branch: added.branch, detached: added.detached },
      list: list.entries.map((e) => ({ branch: e.branch, detached: e.detached, main: e.main })),
    };
  },
};

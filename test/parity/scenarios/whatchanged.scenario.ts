/**
 * Whatchanged scenario — seeds a three-commit linear history (root add, a second
 * add, then a rename) so the per-commit change pairing and rename detection run
 * identically on Node, memory, and the browser. Each entry's structured changes
 * (status letters + paths) must match across adapters.
 *
 * Surfaces closed:
 *   commands: whatchanged
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface WhatchangedScenarioResult {
  readonly entries: ReadonlyArray<{
    readonly message: string;
    readonly changes: ReadonlyArray<{ readonly type: string; readonly path: string }>;
  }>;
}

/** Normalise a change to `{ type, path }` using the new path where it exists. */
const pathOf = (change: {
  readonly type: string;
  readonly newPath?: string;
  readonly oldPath?: string;
  readonly path?: string;
}): string => change.newPath ?? change.path ?? change.oldPath ?? '';

export const whatchangedScenario: Scenario<WhatchangedScenarioResult> = {
  name: 'whatchanged',
  inputs: {
    files: [FILES.helloA, FILES.helloB],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    entries: [
      { message: 'rename a\n', changes: [{ type: 'rename', path: 'c.txt' }] },
      { message: 'second commit\n', changes: [{ type: 'add', path: 'b.txt' }] },
      { message: 'seed commit\n', changes: [{ type: 'add', path: 'a.txt' }] },
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: 'seed commit', author: inputs.author });
    await repo.add(['b.txt']);
    await repo.commit({
      message: 'second commit',
      author: { ...inputs.author, timestamp: inputs.author.timestamp + 100 },
    });
    await repo.mv(['a.txt'], 'c.txt');
    await repo.commit({
      message: 'rename a',
      author: { ...inputs.author, timestamp: inputs.author.timestamp + 200 },
    });

    const entries = await repo.whatchanged();
    return {
      entries: entries.map((e) => ({
        message: e.message,
        changes: e.changes.changes.map((c) => ({ type: c.type, path: pathOf(c) })),
      })),
    };
  },
};

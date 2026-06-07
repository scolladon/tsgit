/**
 * Shortlog scenario — seeds three commits across two authors (a two-commit
 * group and a one-commit group) so the identity grouping, oldest-first ordering,
 * and byte-wise group sort run identically on Node, memory, and the browser.
 *
 * Surfaces closed:
 *   commands: shortlog
 */
import type { AuthorIdentity } from '../../../src/domain/objects/author-identity.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

const SECOND_AUTHOR: AuthorIdentity = {
  name: 'Zed Author',
  email: 'zed@tsgit.dev',
  timestamp: AUTHOR.timestamp + 100,
  timezoneOffset: '+0000',
};

interface ShortlogScenarioResult {
  readonly groups: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly first: string;
  }>;
}

export const shortlogScenario: Scenario<ShortlogScenarioResult> = {
  name: 'shortlog',
  inputs: {
    files: [FILES.helloA, FILES.helloB, { path: 'c.txt', content: 'hello c\n' }],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    // Byte-sorted by name: 'Zed Author' (0x5A) precedes 'tsgit Parity' (0x74).
    groups: [
      { name: 'Zed Author', count: 1, first: 'second commit' },
      { name: 'tsgit Parity', count: 2, first: 'seed commit' },
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: 'seed commit', author: inputs.author });
    await repo.add(['b.txt']);
    await repo.commit({ message: 'second commit', author: SECOND_AUTHOR });
    await repo.add(['c.txt']);
    await repo.commit({
      message: 'third commit',
      author: { ...inputs.author, timestamp: inputs.author.timestamp + 200 },
    });

    const groups = await repo.shortlog();
    return {
      groups: groups.map((g) => ({
        name: g.name,
        count: g.commits.length,
        first: g.commits[0]?.subject ?? '',
      })),
    };
  },
};

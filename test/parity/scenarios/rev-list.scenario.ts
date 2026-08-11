/**
 * Rev-list scenario — seeds a single commit then exercises
 * `repo.revList({ objects: true })`. Object ids are content-addressed and
 * therefore reproducible, but the walk's own emission order is unspecified
 * — so the golden value is a structural summary (count plus each entry's
 * type/path, sorted for a stable comparison), never the raw ids or their
 * order.
 *
 * Surfaces closed:
 *   commands: revList
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface RevListEntrySummary {
  readonly type: string;
  readonly path: string | null;
}

interface RevListScenarioResult {
  readonly count: number;
  readonly kinds: ReadonlyArray<RevListEntrySummary>;
}

const byTypeThenPath = (a: RevListEntrySummary, b: RevListEntrySummary): number =>
  `${a.type}:${a.path ?? ''}`.localeCompare(`${b.type}:${b.path ?? ''}`);

export const revListScenario: Scenario<RevListScenarioResult> = {
  name: 'rev-list',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    count: 3,
    kinds: [
      { type: 'blob', path: 'a.txt' },
      { type: 'commit', path: null },
      { type: 'tree', path: '' },
    ],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.revList({ objects: true });
    const kinds = result.entries
      .map((entry) => ({ type: entry.type, path: entry.path ?? null }))
      .sort(byTypeThenPath);
    return { count: result.count, kinds };
  },
};

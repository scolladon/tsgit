/**
 * Name-rev scenario — seeds a two-commit linear history and tags the tip, then
 * names the root commit with `repo.nameRev()` so the reverse-reachability walk
 * and the structured `~`/`^` path run identically on Node, memory, and the
 * browser. The chosen ref, the annotated-tag flag, and the rendered step suffix
 * must match across adapters.
 *
 * Surfaces closed:
 *   commands: nameRev
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface NameRevScenarioResult {
  readonly ref: string | undefined;
  readonly tagDeref: boolean;
  readonly suffix: string;
}

const renderSuffix = (
  steps: ReadonlyArray<
    | { readonly kind: 'ancestor'; readonly count: number }
    | { readonly kind: 'parent'; readonly number: number }
  >,
): string => steps.map((s) => (s.kind === 'ancestor' ? `~${s.count}` : `^${s.number}`)).join('');

export const nameRevScenario: Scenario<NameRevScenarioResult> = {
  name: 'name-rev',
  inputs: { files: [FILES.helloA, FILES.helloB], author: AUTHOR, message: MESSAGES.seed },
  expected: { ref: 'refs/tags/v1.0', tagDeref: false, suffix: '~1' },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const root = await repo.commit({ message: inputs.message, author: inputs.author });
    await repo.add(['b.txt']);
    await repo.commit({
      message: 'second commit',
      author: { ...inputs.author, timestamp: inputs.author.timestamp + 100 },
    });
    await repo.tag.create({ name: 'v1.0' });

    const result = await repo.nameRev(root.id);
    return { ref: result.ref, tagDeref: result.tagDeref, suffix: renderSuffix(result.steps) };
  },
};

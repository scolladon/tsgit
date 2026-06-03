/**
 * Show scenario — seeds a single root commit then exercises `repo.show()` on
 * HEAD. Asserts the structured result kind and the resolved commit oid,
 * identically on Node and in the browser.
 *
 * Surfaces closed:
 *   commands: show
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface ShowScenarioResult {
  readonly kind: string;
  readonly id: string;
}

export const showScenario: Scenario<ShowScenarioResult> = {
  name: 'show',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    kind: 'commit',
    id: 'fa8b886eee0d470d870e786878657cac05d686e6',
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.show();
    return { kind: result.kind, id: result.kind === 'commit' ? result.id : '' };
  },
};

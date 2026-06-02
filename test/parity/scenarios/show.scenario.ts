/**
 * Show scenario — seeds a single root commit then exercises `repo.show()` on
 * HEAD. Asserts the rendered head line (resolved oid) and that the faithful
 * `bytes` stream begins with it, identically on Node and in the browser.
 *
 * Surfaces closed:
 *   commands: show
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface ShowScenarioResult {
  readonly kind: string;
  readonly headLine: string;
  readonly bytesStartsWithHead: boolean;
}

export const showScenario: Scenario<ShowScenarioResult> = {
  name: 'show',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    kind: 'commit',
    headLine: 'commit fa8b886eee0d470d870e786878657cac05d686e6',
    bytesStartsWithHead: true,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.show();
    const head = result.objects[0];
    const headLine = head?.kind === 'commit' ? (head.text.split('\n')[0] ?? '') : '';
    const bytesStartsWithHead = new TextDecoder().decode(result.bytes).startsWith(headLine);
    return { kind: head?.kind ?? 'none', headLine, bytesStartsWithHead };
  },
};

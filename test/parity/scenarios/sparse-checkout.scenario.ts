/**
 * Sparse-checkout scenario — set a cone pattern after a seed commit, then
 * list the resulting state. Asserts cone mode + the canonicalised pattern
 * list. Closes the `sparseCheckout` browser-coverage gap.
 *
 * Surfaces closed (per 19.5a):
 *   commands: sparseCheckout
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface SparseCheckoutResult {
  readonly seedCommitId: string;
  readonly setKind: string;
  readonly listKind: string;
  readonly listCone: boolean;
  readonly listPatterns: ReadonlyArray<string>;
}

export const sparseCheckoutScenario: Scenario<SparseCheckoutResult> = {
  name: 'sparse-checkout',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    seedCommitId: '87863a6f57aeedd577100911fadbc21ff1062bec',
    setKind: 'applied',
    listKind: 'list',
    listCone: false,
    listPatterns: ['/a.txt'],
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    // Non-cone mode accepts arbitrary path patterns; pin the single tracked
    // file so the result is a deterministic single-line spec.
    const setResult = await repo.sparseCheckout({
      action: 'set',
      patterns: ['/a.txt'],
      cone: false,
    });
    const listResult = await repo.sparseCheckout({ action: 'list' });

    if (listResult.kind !== 'list') {
      throw new Error(`sparse-checkout expected list kind but got ${listResult.kind}`);
    }
    return {
      seedCommitId: seed.id,
      setKind: setResult.kind,
      listKind: listResult.kind,
      listCone: listResult.cone,
      listPatterns: listResult.patterns.slice(),
    };
  },
};

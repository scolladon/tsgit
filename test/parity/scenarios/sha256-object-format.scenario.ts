import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface Sha256ObjectFormatResult {
  readonly init: { initialBranch: string; bare: boolean };
  readonly add: { added: ReadonlyArray<string> };
  readonly commit: { id: string; branch: string | undefined };
}

/**
 * Proves the SAME 64-hex oids on the Memory, Node and Browser drivers when
 * `openOptions.algorithm` selects SHA-256 — cross-adapter agreement only;
 * faithfulness against real git is the interop suite's job
 * (`test/integration/sha256-object-format-interop.test.ts`).
 */
export const sha256ObjectFormatScenario: Scenario<Sha256ObjectFormatResult> = {
  name: 'sha256-object-format',
  openOptions: { algorithm: 'sha256' },
  inputs: {
    files: [FILES.helloA],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    init: { initialBranch: 'main', bare: false },
    add: { added: ['a.txt'] },
    // 64-hex golden — SHA-256 object format. Node baseline; Memory and
    // Browser drivers assert the same value; divergence proves a parity
    // bug in the sha256 hashing/serialization path.
    commit: {
      id: '544c985c675aa542377ad2eae0d1e8955abe686a9ed2009db645c42aac147f65',
      branch: 'refs/heads/main',
    },
  },
  run: async (repo, inputs) => {
    // `objectFormat: 'sha256'` keeps the on-disk config faithful to
    // `openOptions.algorithm` — both channels agree, as a real caller would.
    const init = await repo.init({ objectFormat: 'sha256' });
    const add = await repo.add(inputs.files.map((file) => file.path));
    const commit = await repo.commit({ message: inputs.message, author: inputs.author });
    return {
      init: { initialBranch: init.initialBranch, bare: init.bare },
      add: { added: add.added.slice() },
      commit: { id: commit.id, branch: commit.branch },
    };
  },
};

/**
 * Submodules scenario — confirms both the `submodules` command and the
 * `walkSubmodules` primitive run cleanly on a plain repo (no
 * `.gitmodules`, no gitlinks). The empty case is the cheapest way to
 * close browser coverage; nested submodule walks belong to integration.
 *
 * Surfaces closed (per 19.5a):
 *   commands:   submodules
 *   primitives: walkSubmodules
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface SubmodulesEmptyResult {
  readonly seedCommitId: string;
  readonly submodulesKind: string;
  readonly submodulesEntries: ReadonlyArray<unknown>;
  readonly walkSubmodulesCount: number;
}

export const submodulesEmptyScenario: Scenario<SubmodulesEmptyResult> = {
  name: 'submodules-empty',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    seedCommitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    submodulesKind: 'list',
    submodulesEntries: [],
    walkSubmodulesCount: 0,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    const list = await repo.submodules({ action: 'list' });

    let walkSubmodulesCount = 0;
    for await (const _ of repo.primitives.walkSubmodules()) walkSubmodulesCount += 1;

    return {
      seedCommitId: seed.id,
      submodulesKind: list.kind,
      submodulesEntries: list.entries.slice(),
      walkSubmodulesCount,
    };
  },
};

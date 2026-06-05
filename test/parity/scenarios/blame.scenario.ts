/**
 * Blame scenario — seeds a single-line root commit, then exercises
 * `repo.blame()` so line-by-line authorship runs identically on Node, Memory,
 * and the browser. Asserts the structured per-line result (count, decoded
 * content, root boundary, blamed commit) without pinning an oid.
 *
 * Surfaces closed:
 *   commands: blame
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface BlameScenarioResult {
  readonly lineCount: number;
  readonly content: string;
  readonly boundary: boolean;
  readonly blamesSeed: boolean;
}

export const blameScenario: Scenario<BlameScenarioResult> = {
  name: 'blame',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    lineCount: 1,
    content: FILES.helloA.content,
    boundary: true,
    blamesSeed: true,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add([FILES.helloA.path]);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.blame(FILES.helloA.path);
    const line = result.lines[0];
    const committed = line?.committed === true ? line : undefined;
    return {
      lineCount: result.lines.length,
      content: line === undefined ? '' : new TextDecoder().decode(line.content),
      boundary: committed?.boundary ?? false,
      blamesSeed: committed?.commit === seed.id,
    };
  },
};

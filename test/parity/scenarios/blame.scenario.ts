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
  readonly worktreeCommitted: ReadonlyArray<boolean>;
  readonly worktreeContents: ReadonlyArray<string>;
  readonly worktreeLine1BlamesSeed: boolean;
}

export const blameScenario: Scenario<BlameScenarioResult> = {
  name: 'blame',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    lineCount: 1,
    content: FILES.helloA.content,
    boundary: true,
    blamesSeed: true,
    worktreeCommitted: [true, false],
    worktreeContents: [FILES.helloA.content, 'uncommitted\n'],
    worktreeLine1BlamesSeed: true,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add([FILES.helloA.path]);
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.blame(FILES.helloA.path);
    const line = result.lines[0];
    const committed = line?.committed === true ? line : undefined;

    // Dirty the worktree (keep the committed line, append an uncommitted one) and
    // blame the pseudo-commit — runs identically across Node, Memory, and Browser.
    const ctx = repo.ctx;
    await ctx.fs.writeUtf8(
      `${ctx.layout.workDir}/${FILES.helloA.path}`,
      `${FILES.helloA.content}uncommitted\n`,
    );
    const worktreeResult = await repo.blame(FILES.helloA.path, { worktree: true });
    const worktreeLine1 = worktreeResult.lines[0];
    const worktreeLine1Committed = worktreeLine1?.committed === true ? worktreeLine1 : undefined;

    return {
      lineCount: result.lines.length,
      content: line === undefined ? '' : new TextDecoder().decode(line.content),
      boundary: committed?.boundary ?? false,
      blamesSeed: committed?.commit === seed.id,
      worktreeCommitted: worktreeResult.lines.map((l) => l.committed),
      worktreeContents: worktreeResult.lines.map((l) => new TextDecoder().decode(l.content)),
      worktreeLine1BlamesSeed: worktreeLine1Committed?.commit === seed.id,
    };
  },
};

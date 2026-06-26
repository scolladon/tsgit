/**
 * Archive scenario — seeds a single root commit containing one regular file,
 * then calls `repo.archive({ treeish: 'HEAD' })` and drains the entry
 * stream, counting entries and checking commit metadata presence. Runs
 * identically on Node, memory, and browser (OPFS) adapters; the projection
 * maps to counts and boolean flags so oids never appear in the assertion.
 *
 * Surfaces closed:
 *   commands: archive
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface ArchiveScenarioResult {
  readonly entryCount: number;
  readonly hasCommit: boolean;
  readonly hasCommitTime: boolean;
}

export const archiveScenario: Scenario<ArchiveScenarioResult> = {
  name: 'archive',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    // One regular file entry — no directory or gitlink in this minimal seed.
    entryCount: 1,
    // archive() with a commit-ish always surfaces the commit oid.
    hasCommit: true,
    // commit-ish archives always carry the committer timestamp.
    hasCommitTime: true,
  },
  run: async (repo, inputs) => {
    // Arrange — seed a healthy root commit
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    // Act
    const result = await repo.archive({ treeish: 'HEAD' });

    // Assert — drain the entries, count them
    let entryCount = 0;
    for await (const _entry of result.entries) {
      entryCount += 1;
    }

    return {
      entryCount,
      hasCommit: result.commit !== undefined,
      hasCommitTime: result.commitTime !== undefined,
    };
  },
};

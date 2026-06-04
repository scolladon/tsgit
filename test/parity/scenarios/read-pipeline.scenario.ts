/**
 * Read-tier pipeline scenario — exercises every read-side primitive plus
 * the `catFile` command in one bundled scenario. Each surface is invoked
 * against the seed commit; the result is projected to deterministic
 * fields only (counts, ids, kinds) so the golden survives across
 * adapters (the working-tree stat fields are non-deterministic and
 * deliberately omitted).
 *
 * Surfaces closed (per 19.5a):
 *   commands:   catFile
 *   primitives: readObject, readTree, readIndex, getRepoRoot, walkCommits,
 *               walkCommitsByDate, walkTree, walkWorkingTree, catFileBatch
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface ReadPipelineResult {
  readonly commitId: string;
  readonly readObjectType: string;
  readonly readTreeEntryCount: number;
  readonly readIndexEntryCount: number;
  readonly repoRootResolved: boolean;
  readonly walkCommitsCount: number;
  readonly walkCommitsByDateCount: number;
  readonly walkTreeCount: number;
  readonly walkWorkingTreeCount: number;
  readonly catFileEntryKind: string;
  readonly catFileBatchType: string;
}

export const readPipelineScenario: Scenario<ReadPipelineResult> = {
  name: 'read-pipeline',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    commitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    readObjectType: 'commit',
    readTreeEntryCount: 1,
    readIndexEntryCount: 1,
    repoRootResolved: true,
    walkCommitsCount: 1,
    walkCommitsByDateCount: 1,
    walkTreeCount: 1,
    walkWorkingTreeCount: 1,
    catFileEntryKind: 'batch',
    catFileBatchType: 'commit',
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    const commit = await repo.commit({ message: inputs.message, author: inputs.author });

    const obj = await repo.primitives.readObject(commit.id);
    const tree = await repo.primitives.readTree(commit.id);
    const index = await repo.primitives.readIndex();
    const repoRoot = repo.primitives.getRepoRoot();

    let walkCommitsCount = 0;
    for await (const _ of repo.primitives.walkCommits({ from: [commit.id] })) walkCommitsCount += 1;
    let walkCommitsByDateCount = 0;
    for await (const _ of repo.primitives.walkCommitsByDate({ from: [commit.id] }))
      walkCommitsByDateCount += 1;
    let walkTreeCount = 0;
    for await (const _ of repo.primitives.walkTree(tree.id, { recursive: true }))
      walkTreeCount += 1;
    let walkWorkingTreeCount = 0;
    for await (const _ of repo.primitives.walkWorkingTree()) walkWorkingTreeCount += 1;

    const catFile = await repo.catFile({ ids: [commit.id] });

    let catFileBatchType = '';
    for await (const entry of repo.primitives.catFileBatch([commit.id])) {
      if (entry.ok) catFileBatchType = entry.type;
      break;
    }

    return {
      commitId: commit.id,
      readObjectType: obj.type,
      readTreeEntryCount: tree.entries.length,
      readIndexEntryCount: index.entries.length,
      repoRootResolved: typeof repoRoot === 'string' && repoRoot.length > 0,
      walkCommitsCount,
      walkCommitsByDateCount,
      walkTreeCount,
      walkWorkingTreeCount,
      catFileEntryKind: catFile.kind,
      catFileBatchType,
    };
  },
};

/**
 * Shallow-walk scenario — seeds a three-commit linear history (root → mid →
 * tip) and writes a `.git/shallow` boundary directly onto the middle commit,
 * so `walkCommits` cuts there identically on Node, memory, and the browser
 * adapters. Proves the common-dir path resolution and the graft are
 * adapter-independent; NOT a faithfulness proof (that lives in
 * `test/integration/shallow-walk-interop.test.ts`).
 */
import type { ObjectId } from '../../../src/domain/objects/object-id.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

export const shallowWalkScenario: Scenario<ReadonlyArray<string>> = {
  name: 'shallow-walk',
  inputs: { files: [], author: AUTHOR, message: 'seed' },
  expected: [
    'd1edda4bc7dd1e883ab0d38e1926b87d5d42eb8a',
    'abf61ec362a9da85f809d8bcb7f2471b84574d46',
  ],
  run: async (repo, inputs) => {
    await repo.init();
    const treeId: ObjectId = await repo.primitives.writeObject({
      type: 'tree',
      id: '' as ObjectId,
      entries: [],
    });
    const mkCommit = (ts: number, parents: ObjectId[]): Promise<ObjectId> =>
      repo.primitives.createCommit({
        tree: treeId,
        parents,
        author: { ...inputs.author, timestamp: ts },
        committer: { ...inputs.author, timestamp: ts },
        message: `c@${ts}`,
      });

    const root = await mkCommit(100, []);
    const mid = await mkCommit(101, [root]);
    const tip = await mkCommit(102, [mid]);

    await repo.ctx.fs.writeUtf8(`${repo.ctx.layout.gitDir}/shallow`, `${mid}\n`);

    const ids: string[] = [];
    for await (const commit of repo.primitives.walkCommits({ from: [tip] })) {
      ids.push(commit.id);
    }
    return ids;
  },
};

/**
 * Maintenance scenario — seeds a single commit then exercises
 * `repo.maintenance({ tasks: ['commit-graph'] })`. `commitsInGraph` is a
 * deterministic count; the on-disk `objects/info/commit-graph` file is read
 * back and re-parsed as the readback proof that the written bytes hold
 * exactly that commit.
 *
 * Surfaces closed:
 *   commands: maintenance
 */
import { commitGraphPath, commonGitDir } from '../../../src/application/primitives/path-layout.ts';
import { parseCommitGraphLayer } from '../../../src/domain/commit/commit-graph.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface MaintenanceScenarioResult {
  readonly tasksRun: ReadonlyArray<string>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
  readonly graphCommitCount: number;
}

export const maintenanceScenario: Scenario<MaintenanceScenarioResult> = {
  name: 'maintenance',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    tasksRun: ['commit-graph'],
    commitGraphWritten: true,
    commitsInGraph: 1,
    graphCommitCount: 1,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.maintenance({ tasks: ['commit-graph'] });

    const gitDir = commonGitDir(repo.ctx);
    const bytes = await repo.ctx.fs.read(commitGraphPath(gitDir));
    const layer = parseCommitGraphLayer(bytes);

    return {
      tasksRun: result.tasksRun,
      commitGraphWritten: result.commitGraphWritten,
      commitsInGraph: result.commitsInGraph,
      graphCommitCount: layer.commitCount,
    };
  },
};

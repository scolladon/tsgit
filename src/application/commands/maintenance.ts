/**
 * Tier-1 `maintenance` command — explicit-only invocation of tsgit-managed
 * repository upkeep (git's `git maintenance run`, minus the timer and the
 * `--auto` threshold gate). Never auto-triggered: no timer, no threshold
 * check inside `status`, no write-path hook — a caller decides when
 * maintenance happens.
 *
 * Ships the `commit-graph` task only. `gc` — and the `auto` option that
 * gates it — lands in a later part: shipping `auto` here, with nothing yet
 * for it to gate, would be a declared-but-inert public option.
 */
import { invalidOption } from '../../domain/commands/error.js';
import type { Context } from '../../ports/context.js';
import { writeCommitGraph } from '../primitives/write-commit-graph.js';
import { assertOperationalRepository } from './internal/repo-state.js';

export type MaintenanceTask = 'commit-graph';

export interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
}

export interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
}

const KNOWN_TASKS: ReadonlySet<MaintenanceTask> = new Set(['commit-graph']);

const validateTasks = (tasks: ReadonlyArray<MaintenanceTask>): void => {
  if (tasks.length === 0) throw invalidOption('tasks', 'at least one task required');
  for (const task of tasks) {
    if (!KNOWN_TASKS.has(task)) throw invalidOption('tasks', `'${task}' is not a valid task`);
  }
};

const runCommitGraphTask = async (
  ctx: Context,
): Promise<Pick<MaintenanceResult, 'commitGraphWritten' | 'commitsInGraph'>> => {
  const { commitCount } = await writeCommitGraph(ctx);
  return { commitGraphWritten: commitCount > 0, commitsInGraph: commitCount };
};

export const maintenance = async (
  ctx: Context,
  opts: MaintenanceOptions,
): Promise<MaintenanceResult> => {
  await assertOperationalRepository(ctx);
  validateTasks(opts.tasks);

  const { commitGraphWritten, commitsInGraph } = await runCommitGraphTask(ctx);

  return { tasksRun: opts.tasks, commitGraphWritten, commitsInGraph };
};

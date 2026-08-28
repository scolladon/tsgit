/**
 * Tier-1 `maintenance` command — explicit-only invocation of tsgit-managed
 * repository upkeep (git's `git maintenance run`, minus the timer and the
 * `--auto` threshold gate). Never auto-triggered: no timer, no threshold
 * check inside `status`, no write-path hook — a caller decides when
 * maintenance happens, and only the tasks it names run.
 *
 * Ships two tasks. `commit-graph` writes `objects/info/commit-graph`.
 * `gc` consolidates every pack it owns, by class: reachable objects — loose,
 * already packed, or living in a promisor pack — repack into one new normal
 * pack; every promisor object ALSO repacks whole into one new promisor
 * pack, so a reachable one duplicates into both (git does the same — it is
 * not a `.keep`-style exclusion from the normal pack), while an unreachable
 * one stays exclusive to the promisor pack; the two are never MERGED into a
 * single pack (that would tell a later reader that lazily-fetched objects
 * are already present locally); and unreachable, non-promisor objects route
 * through git's cruft-pack lifecycle wherever they lived. Superseded packs
 * and every sibling artefact are retired; an existing multi-pack-index
 * naming any of them is expired. `*.keep`-marked packs are the only total
 * exclusion, exactly as git excludes them. After every pack write and
 * retirement this run performs, `gc` also deletes stale quarantine litter
 * aged past `gc.pruneExpire` — `tmp_`-prefixed at `objects/` root and
 * `objects/pack/`, `tmp_obj_`-prefixed within a fanout dir — but only on a
 * run that actually proceeds past the `gc.auto` gate, never on a declined
 * one.
 */
import { invalidOption } from '../../domain/commands/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { writeCommitGraph } from '../primitives/write-commit-graph.js';
import { GC_NOT_RUN, type GcResult, runGcTask } from './internal/gc-pipeline.js';
import { assertOperationalRepository } from './internal/repo-state.js';

export type MaintenanceTask = 'commit-graph' | 'gc';

export interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  /**
   * Mirrors `git maintenance run --auto`: gates the `gc` task on
   * `gc.auto` (default 6700 loose objects; `0` disables the gate). Absent
   * or `false` runs `gc` unconditionally, exactly as an explicit `git gc`
   * ignores `gc.auto` entirely. Has no effect on `commit-graph`.
   */
  readonly auto?: boolean;
}

export interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
  readonly looseObjectsBefore: number;
  readonly looseObjectsPacked: number;
  readonly prunedLooseObjects: number;
  readonly packsBefore: number;
  readonly packsAfter: number;
  /** The normal pack's sha, or `undefined` when no reachable object was packed. */
  readonly packId: ObjectId | undefined;
  readonly cruftObjectsAdded: number;
  readonly cruftObjectsRetained: number;
  readonly cruftObjectsExpired: number;
  /** The cruft pack's sha, or `undefined` when no cruft pack exists afterward. */
  readonly cruftPackId: ObjectId | undefined;
  /** The promisor pack's sha, or `undefined` when no promisor object is
   *  owned before or after this run — the common, non-partial-clone case. */
  readonly promisorPackId: ObjectId | undefined;
  /** Superseded packs deleted by this call — normal, cruft and promisor combined. */
  readonly packsRetired: number;
  /** Summed `.pack` bytes in `objects/pack/` before the call — the
   *  denominator for observing consolidation's size trade. */
  readonly packBytesBefore: number;
  /** The same sum after the call. */
  readonly packBytesAfter: number;
}

const KNOWN_TASKS: ReadonlySet<MaintenanceTask> = new Set(['commit-graph', 'gc']);

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

/** `tasks` with later duplicates dropped, first occurrence's position kept —
 *  the shape `maintenance`'s task loop needs to run each requested task
 *  exactly once, in the order it was FIRST requested. */
function orderedUniqueTasks(tasks: ReadonlyArray<MaintenanceTask>): ReadonlyArray<MaintenanceTask> {
  const seen = new Set<MaintenanceTask>();
  const ordered: MaintenanceTask[] = [];
  for (const task of tasks) {
    if (seen.has(task)) continue;
    seen.add(task);
    ordered.push(task);
  }
  return ordered;
}

export const maintenance = async (
  ctx: Context,
  opts: MaintenanceOptions,
): Promise<MaintenanceResult> => {
  await assertOperationalRepository(ctx);
  validateTasks(opts.tasks);

  // Pinned against git 2.55.0 (`GIT_TRACE=1 git maintenance run --task=…
  // --task=…`, both orderings): `git maintenance run` executes requested
  // tasks in the order they were REQUESTED, not a fixed internal priority —
  // `--task=commit-graph --task=gc` runs commit-graph first;
  // `--task=gc --task=commit-graph` runs gc first. Mirrored here rather
  // than hard-coding either task first.
  let commitGraphOutcome: Pick<MaintenanceResult, 'commitGraphWritten' | 'commitsInGraph'> = {
    commitGraphWritten: false,
    commitsInGraph: 0,
  };
  // Stryker disable next-line BooleanLiteral: equivalent — `gcOutcome.ran` is read only inside the loop below, immediately after `gcOutcome` is reassigned in that same iteration's `gc` branch; the final return spreads only `.result`, never `.ran`. This initial value is therefore never observed, whichever task list is requested.
  let gcOutcome: { readonly ran: boolean; readonly result: GcResult } = {
    ran: false,
    result: GC_NOT_RUN,
  };
  const tasksRun: MaintenanceTask[] = [];

  for (const task of orderedUniqueTasks(opts.tasks)) {
    if (task === 'commit-graph') {
      commitGraphOutcome = await runCommitGraphTask(ctx);
      tasksRun.push('commit-graph');
      continue;
    }
    gcOutcome = await runGcTask(ctx, { auto: opts.auto });
    if (gcOutcome.ran) tasksRun.push('gc');
  }

  return { tasksRun, ...commitGraphOutcome, ...gcOutcome.result };
};

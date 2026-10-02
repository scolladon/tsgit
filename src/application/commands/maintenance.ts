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
 * one. A `gc` that ran then rewrites the reachable commit-graph as one file,
 * dropping any split chain, unless `gc.writeCommitGraph` or
 * `core.commitGraph` is false.
 */
import { invalidOption } from '../../domain/commands/error.js';
import { parseGitBoolean } from '../../domain/config/config-ini.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { findLastEntry } from '../primitives/config-read.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { writeCommitGraph } from '../primitives/write-commit-graph.js';
import { GC_NOT_RUN, type GcResult, readGcSettings, runGcTask } from './internal/gc-pipeline.js';
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

type CommitGraphOutcome = Pick<MaintenanceResult, 'commitGraphWritten' | 'commitsInGraph'>;

const NO_COMMIT_GRAPH: CommitGraphOutcome = { commitGraphWritten: false, commitsInGraph: 0 };

/** A boolean key set to false, its last value read as git's config set does. */
const lastBooleanIsFalse = async (ctx: Context, section: string, key: string): Promise<boolean> => {
  const last = await findLastEntry(ctx, section, key);
  if (last?.value == null) return false;
  const parsed = parseGitBoolean(last.value);
  return parsed.ok && !parsed.value;
};

const writeReachableCommitGraph = async (ctx: Context): Promise<CommitGraphOutcome> => {
  const { commitCount } = await writeCommitGraph(ctx);
  return { commitGraphWritten: commitCount > 0, commitsInGraph: commitCount };
};

/** git's `maintenance_task_commit_graph`: `prepare_repo_settings` first, then a
 *  disabled `core.commitGraph` skips the write, silently. */
const runCommitGraphTask = async (ctx: Context): Promise<CommitGraphOutcome> => {
  await assertRepoSettingsValid(ctx);
  if (await lastBooleanIsFalse(ctx, 'core', 'commitGraph')) return NO_COMMIT_GRAPH;
  return writeReachableCommitGraph(ctx);
};

/** git's `cmd_gc` tail: a gc that ran writes the reachable commit-graph unless
 *  `gc.writeCommitGraph` or `core.commitGraph` is false; `undefined` when it does not. */
const writeGcCommitGraph = async (ctx: Context): Promise<CommitGraphOutcome | undefined> => {
  await assertRepoSettingsValid(ctx);
  if (await lastBooleanIsFalse(ctx, 'gc', 'writeCommitGraph')) return undefined;
  if (await lastBooleanIsFalse(ctx, 'core', 'commitGraph')) return undefined;
  return writeReachableCommitGraph(ctx);
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
  const gcSettings = await readGcSettings(ctx);

  // Pinned against git 2.55.0 (`GIT_TRACE=1 git maintenance run --task=…
  // --task=…`, both orderings): `git maintenance run` executes requested
  // tasks in the order they were REQUESTED, not a fixed internal priority —
  // `--task=commit-graph --task=gc` runs commit-graph first;
  // `--task=gc --task=commit-graph` runs gc first. Mirrored here rather
  // than hard-coding either task first.
  let commitGraphOutcome = NO_COMMIT_GRAPH;
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
    gcOutcome = await runGcTask(ctx, { auto: opts.auto, settings: gcSettings });
    if (!gcOutcome.ran) continue;
    tasksRun.push('gc');
    commitGraphOutcome = (await writeGcCommitGraph(ctx)) ?? commitGraphOutcome;
  }

  return { tasksRun, ...commitGraphOutcome, ...gcOutcome.result };
};

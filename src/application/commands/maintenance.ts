/**
 * Tier-1 `maintenance` command — explicit-only invocation of tsgit-managed
 * repository upkeep (git's `git maintenance run`, minus the timer and the
 * `--auto` threshold gate). Never auto-triggered: no timer, no threshold
 * check inside `status`, no write-path hook — a caller decides when
 * maintenance happens, and only the tasks it names run.
 *
 * Ships two tasks. `commit-graph` writes one split layer of the commit-graph
 * chain, as `git commit-graph write --split --reachable` does — nothing when
 * every reachable commit is already in the graph.
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
import type { TsgitErrorData } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { findLastEntry } from '../primitives/config-read.js';
import { hasReplaceRefs } from '../primitives/internal/commit-graph-compatible.js';
import { assertValidGcAutoConfig } from '../primitives/internal/gc-config-guard.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { writeCommitGraph } from '../primitives/write-commit-graph.js';
import { writeSplitCommitGraph } from '../primitives/write-split-commit-graph.js';
import {
  GC_NOT_RUN,
  type GcResult,
  type GcSettings,
  readGcSettings,
  runGcTask,
} from './internal/gc-pipeline.js';
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

/** A task git reports as `task '<name>' failed`: the run goes on and exits 1. */
export interface MaintenanceTaskFailure {
  readonly task: MaintenanceTask;
  /** The error code of the refusal the task met. */
  readonly code: string;
  /** The refusal itself — enough to rebuild the `fatal:` line git's task child prints. */
  readonly data: TsgitErrorData;
}

export interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  /** Tasks that failed, in run order; any entry is git's exit status 1. */
  readonly tasksFailed: ReadonlyArray<MaintenanceTaskFailure>;
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
 *  disabled `core.commitGraph` skips the write, silently; otherwise one split
 *  layer, `commitsInGraph` counting the whole chain. */
const runCommitGraphTask = async (
  ctx: Context,
): Promise<CommitGraphOutcome | MaintenanceTaskFailure> => {
  await assertRepoSettingsValid(ctx);
  if (await lastBooleanIsFalse(ctx, 'core', 'commitGraph')) return NO_COMMIT_GRAPH;
  const written = await failureOr('commit-graph', () => writeSplitCommitGraph(ctx));
  if ('code' in written) return written;
  return { commitGraphWritten: written.written, commitsInGraph: written.commitCount };
};

/** git's gc task: the parent's own object-store reads settle the repo settings
 *  first, dying on a malformed one; under `--auto` the parent also reads
 *  `gc.auto` and `gc.autoPackLimit`, dying on a malformed one; then a coded
 *  refusal from the gc child fails the task. */
const runGcStep = async (
  ctx: Context,
  opts: MaintenanceOptions,
  settings: GcSettings,
): Promise<{ readonly ran: boolean; readonly result: GcResult } | MaintenanceTaskFailure> => {
  await assertRepoSettingsValid(ctx);
  if (opts.auto === true) await assertValidGcAutoConfig(ctx);
  return failureOr('gc', () => runGcTask(ctx, { auto: opts.auto, settings }));
};

const COMMIT_GRAPH_DISABLED_WARNING =
  "attempting to write a commit-graph, but 'core.commitGraph' is disabled";

/** git's `cmd_gc` tail: a gc that ran writes the reachable commit-graph unless
 *  `gc.writeCommitGraph` is false — and `write_commit_graph` itself declines,
 *  warning, when `core.commitGraph` is false, and silently while replace refs
 *  apply, its in-process write not disabling them; `undefined` when nothing is written. */
const writeGcCommitGraph = async (ctx: Context): Promise<CommitGraphOutcome | undefined> => {
  await assertRepoSettingsValid(ctx);
  if (await lastBooleanIsFalse(ctx, 'gc', 'writeCommitGraph')) return undefined;
  if (await lastBooleanIsFalse(ctx, 'core', 'commitGraph')) {
    ctx.logger?.warn?.(COMMIT_GRAPH_DISABLED_WARNING);
    return undefined;
  }
  if (await hasReplaceRefs(ctx)) return undefined;
  return writeReachableCommitGraph(ctx);
};

/** A commit-graph a gc already wrote stays written when a later task finds nothing new to add. */
const laterOutcome = (
  earlier: CommitGraphOutcome,
  later: CommitGraphOutcome,
): CommitGraphOutcome => ({
  commitGraphWritten: earlier.commitGraphWritten || later.commitGraphWritten,
  commitsInGraph: later.commitsInGraph,
});

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

/**
 * Run each requested maintenance task once, in the order first requested.
 * Pinned against git 2.56.0 (`GIT_TRACE=1 git maintenance run --task=…
 * --task=…`, both orderings): `git maintenance run` executes requested tasks
 * in the order they were REQUESTED, not a fixed internal priority —
 * `--task=commit-graph --task=gc` runs commit-graph first;
 * `--task=gc --task=commit-graph` runs gc first. Mirrored here rather than
 * hard-coding either task first.
 */
export const maintenance = async (
  ctx: Context,
  opts: MaintenanceOptions,
): Promise<MaintenanceResult> => {
  await assertOperationalRepository(ctx);
  validateTasks(opts.tasks);
  const gcSettings = await readGcSettings(ctx);
  let progress = NOTHING_RUN;
  for (const task of orderedUniqueTasks(opts.tasks)) {
    progress =
      task === 'commit-graph'
        ? await commitGraphStep(ctx, progress)
        : await gcStep(ctx, { opts, settings: gcSettings }, progress);
  }
  const { tasksRun, tasksFailed } = progress;
  return { tasksRun, tasksFailed, ...progress.commitGraph, ...progress.gc };
};

/** What the tasks run so far have produced. */
interface MaintenanceProgress {
  readonly commitGraph: CommitGraphOutcome;
  readonly gc: GcResult;
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly tasksFailed: ReadonlyArray<MaintenanceTaskFailure>;
}

const NOTHING_RUN: MaintenanceProgress = {
  commitGraph: NO_COMMIT_GRAPH,
  gc: GC_NOT_RUN,
  tasksRun: [],
  tasksFailed: [],
};

const failedStep = (
  progress: MaintenanceProgress,
  failure: MaintenanceTaskFailure,
): MaintenanceProgress => ({ ...progress, tasksFailed: [...progress.tasksFailed, failure] });

const commitGraphStep = async (
  ctx: Context,
  progress: MaintenanceProgress,
): Promise<MaintenanceProgress> => {
  const outcome = await runCommitGraphTask(ctx);
  if ('code' in outcome) return failedStep(progress, outcome);
  return {
    ...progress,
    commitGraph: laterOutcome(progress.commitGraph, outcome),
    tasksRun: [...progress.tasksRun, 'commit-graph'],
  };
};

/** A gc that ran is followed by the commit-graph write git's `cmd_gc` tail performs. */
const gcStep = async (
  ctx: Context,
  config: { readonly opts: MaintenanceOptions; readonly settings: GcSettings },
  progress: MaintenanceProgress,
): Promise<MaintenanceProgress> => {
  const gcRun = await runGcStep(ctx, config.opts, config.settings);
  if ('code' in gcRun) return failedStep(progress, gcRun);
  if (!gcRun.ran) return { ...progress, gc: gcRun.result };
  const tasksRun = [...progress.tasksRun, 'gc' as const];
  const commitGraph = (await writeGcCommitGraph(ctx)) ?? progress.commitGraph;
  return { ...progress, gc: gcRun.result, tasksRun, commitGraph };
};

/** The write git runs as a child: its coded refusal fails the task; anything else is a bug and propagates. */
async function failureOr<T extends object>(
  task: MaintenanceTask,
  run: () => Promise<T>,
): Promise<T | MaintenanceTaskFailure> {
  try {
    return await run();
  } catch (error) {
    const code = errorDataCode(error);
    if (code === undefined) throw error;
    return { task, code, data: (error as { readonly data: TsgitErrorData }).data };
  }
}

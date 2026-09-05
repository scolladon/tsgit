/**
 * Thin Given/When/Then wrapper over vitest's `describe` + `bench`.
 *
 * Bench files otherwise drift from the project's test conventions — bare
 * `describe('log:walk-50-commits')` instead of `Given … When … Then …`, and
 * no named system-under-test. `benchScenario` restores both: the call site
 * names the tsgit closure `sut` and reads as a sentence.
 *
 * The two `bench()` names stay exactly `tsgit` / `isomorphic-git` — the
 * summary script, the `benchmark-compare` CI job, and the snapshot converter
 * all key on them. Only the describe title changes.
 *
 * Every bench receives `throws: true` (see `hooksFor`). Without it, a warmup
 * error is stored on the task and `run` returns before dispatching `complete`
 * or `error`, so vitest reports a pass with an empty `samples` array. Three
 * consequences of that choice, deliberate and recorded here so a future
 * reader does not diagnose them as fresh defects:
 *
 * - A warmup throw aborts the whole bench **file**: scenarios declared after
 *   the failing one never run, so a truncated `reports/benchmarks/raw.json`
 *   is expected, not a second bug.
 * - A throw during the measured **run** (after warmup) rejects inside the
 *   timer callback vitest wraps the run in; that promise never settles and
 *   the worker hangs. Nothing in-process can bound this — the
 *   `benchmark-snapshot` CI job carries `timeout-minutes: 30` (matching
 *   `bench.yml`) so the worst case is a bounded red run.
 * - `removeSync` in `fixture-scratch.ts` swallows and logs rather than
 *   rethrowing. tinybench fires a bench's teardown hook un-awaited, inside
 *   `run`'s own body, so a teardown that throws would land in the same
 *   never-resolving promise as a run-phase failure. Do not "tidy" that
 *   swallow into a rethrow — it is what keeps a cleanup failure from hanging
 *   the runner.
 */
import { type BenchOptions, bench, describe } from 'vitest';

export interface BenchComparison {
  /** The tsgit code path under measurement. */
  readonly sut: () => Promise<void> | void;
  /**
   * The isomorphic-git baseline. Optional: at fixture scale isomorphic-git's
   * walk can be impractically slow, so a scaled scenario may run tsgit-only.
   */
  readonly baseline?: () => Promise<void> | void;
  /**
   * Runs once after the scenario's last measurement. This is the ONLY cleanup
   * that fires under `vitest bench`: the benchmark runner never calls
   * `afterAll`, so a handle or scratch copy released there is never released.
   * tinybench does not await it — remove directories synchronously. It also
   * never fires when the measured function throws during warmup (tinybench
   * skips the run phase and, under `throws: true`, aborts the rest of the
   * bench file with it); a scratch copy left that way is reclaimed by
   * `bench:fixture -- --prune` once its process is gone.
   */
  readonly teardown?: () => Promise<void> | void;
}

type Teardown = () => Promise<void> | void;
type HookMode = 'warmup' | 'run';

/** tinybench calls the hook after warmup and after the measured run; cleanup waits for the run. */
export const onMeasuredRun =
  (teardown: Teardown) =>
  (mode: HookMode): Promise<void> | void =>
    mode === 'run' ? teardown() : undefined;

/**
 * The bench options a scenario attaches. `throws: true` is always set: without it,
 * tinybench stores a warmup error on the task and `run` returns before dispatching
 * `complete` or `error`, so the placeholder `{ rank: 0, rme: 0, samples: [] }` result
 * reports a pass. The task argument is never read, so callers need not build one.
 */
export interface MeasuredRunOptions extends BenchOptions {
  readonly throws: true;
  readonly teardown?: (task: unknown, mode: HookMode) => Promise<void> | void;
}

const throwingOptions = (teardown?: Teardown): MeasuredRunOptions => ({
  throws: true,
  ...(teardown === undefined
    ? {}
    : { teardown: (_task: unknown, mode: HookMode) => onMeasuredRun(teardown)(mode) }),
});

export interface ScenarioHooks {
  readonly tsgit: MeasuredRunOptions;
  readonly baseline: MeasuredRunOptions;
}

/** Every bench gets throwing options; the teardown rides on the scenario's LAST bench, so a baseline still measures on an intact scratch. */
export const hooksFor = (comparison: BenchComparison): ScenarioHooks =>
  comparison.baseline === undefined
    ? { tsgit: throwingOptions(comparison.teardown), baseline: throwingOptions() }
    : { tsgit: throwingOptions(), baseline: throwingOptions(comparison.teardown) };

export interface BenchScenarioOptions {
  /** Skip the whole scenario (missing fixture, Stryker sandbox, …). */
  readonly skip?: boolean;
}

/**
 * Declare a benchmark scenario. `given` is the context phrase, `whenThen` the
 * action + expectation phrase; together they form the describe title. `build`
 * runs inside the describe body — it may boot fixtures, and must release them
 * through the returned `teardown`, since `afterAll` never fires under
 * `vitest bench` — and returns the `sut` (plus optional `baseline`) to measure.
 */
export const benchScenario = (
  given: string,
  whenThen: string,
  build: () => Promise<BenchComparison> | BenchComparison,
  opts: BenchScenarioOptions = {},
): void => {
  const skip = opts.skip ?? false;
  describe.skipIf(skip)(`${given}, ${whenThen}`, async () => {
    // vitest still evaluates the describe callback to enumerate tests even
    // when skipIf is true; without this return, `build` would run (booting
    // servers / fixtures) on a skipped scenario.
    if (skip) return;
    const comparison = await build();
    const hooks = hooksFor(comparison);
    bench('tsgit', comparison.sut, hooks.tsgit);
    if (comparison.baseline !== undefined) {
      bench('isomorphic-git', comparison.baseline, hooks.baseline);
    }
  });
};

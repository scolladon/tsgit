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
 */
import type { Options } from 'tinybench';
import { bench, describe } from 'vitest';

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
   */
  readonly teardown?: () => Promise<void> | void;
}

/** tinybench calls the hook after warmup and after the measured run; cleanup waits for the run. */
const afterMeasuredRun = (teardown: () => Promise<void> | void): Options => ({
  teardown: (_task, mode) => (mode === 'run' ? teardown() : undefined),
});

export interface BenchScenarioOptions {
  /** Skip the whole scenario (missing fixture, Stryker sandbox, …). */
  readonly skip?: boolean;
}

/**
 * Declare a benchmark scenario. `given` is the context phrase, `whenThen` the
 * action + expectation phrase; together they form the describe title. `build`
 * runs inside the describe body — it may boot fixtures and register `afterAll`
 * — and returns the `sut` (plus optional `baseline`) to measure.
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
    const { sut, baseline, teardown } = await build();
    const hooks = teardown === undefined ? undefined : afterMeasuredRun(teardown);
    bench('tsgit', sut, baseline === undefined ? hooks : undefined);
    if (baseline !== undefined) bench('isomorphic-git', baseline, hooks);
  });
};

/**
 * Shared glue for the scaled bench scenarios.
 *
 * Resolves the medium (default) or large (`TSGIT_BENCH_LARGE`) fixture once
 * per bench file and registers a `benchScenario` that skips cleanly when the
 * fixture cannot be built (no `git` CLI, Stryker sandbox).
 */
import { type BenchComparison, benchScenario } from './bench-dsl.js';
import {
  ensureScaledFixture,
  LARGE_FIXTURE,
  MEDIUM_FIXTURE,
  type ScaledFixture,
} from './fixture-generator.js';

export interface ScaledContext {
  readonly fixture?: ScaledFixture;
  /** Given-phrase describing the resolved fixture (or its absence). */
  readonly given: string;
}

/** Resolve the scaled fixture once — call at a bench file's module top level. */
export const resolveScaledContext = async (): Promise<ScaledContext> => {
  const spec = process.env.TSGIT_BENCH_LARGE !== undefined ? LARGE_FIXTURE : MEDIUM_FIXTURE;
  const given = `Given a ${spec.label} repo (${spec.commits} commits, ${spec.blobs} blobs)`;
  if (process.env.STRYKER_MUTANT_ID !== undefined) return { given };
  try {
    const fixture = await ensureScaledFixture(spec);
    return { fixture, given };
  } catch {
    return { given };
  }
};

/** Register a scaled bench scenario; skips when the fixture is unavailable. */
export const scaledScenario = (
  ctx: ScaledContext,
  whenThen: string,
  build: (fixture: ScaledFixture) => Promise<BenchComparison> | BenchComparison,
): void => {
  const { fixture } = ctx;
  benchScenario(
    ctx.given,
    whenThen,
    () => {
      // `build` runs only when the scenario is not skipped, so the fixture is
      // guaranteed present here — the guard just narrows the type.
      if (fixture === undefined) throw new Error('scaled fixture unavailable');
      return build(fixture);
    },
    { skip: fixture === undefined },
  );
};

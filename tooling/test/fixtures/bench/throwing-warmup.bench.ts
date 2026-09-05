/**
 * Fixture for the run-phase-hang guard (see bench-dsl.ts's `throws: true`
 * doc comment): registers a single scenario whose `sut` throws on its very
 * first call, i.e. during vitest's warmup phase. Lives outside
 * `test/bench/**` so the real sweep (`vitest.bench.config.ts`'s
 * `include: ['test/bench/**\/*.bench.ts']`) never runs it — only the
 * integration test that spawns vitest against a config scoped to this one
 * file does.
 *
 * Not imported by that integration test: loading this module outside
 * benchmark mode calls vitest's `bench()` before it is registered, which
 * throws. The sibling test asserts on this file's error message as a
 * literal instead — keep the two in sync.
 */
import { benchScenario } from '../../../../test/bench/support/bench-dsl.js';

benchScenario(
  'Given a scenario whose sut throws on its first (warmup) call',
  'When vitest bench runs it under throws: true, Then the run fails rather than hanging or passing silently',
  () => ({
    sut: (): void => {
      throw new Error('warmup boom: this scenario must fail the run');
    },
  }),
);

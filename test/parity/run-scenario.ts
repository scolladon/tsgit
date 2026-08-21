/**
 * Runs one parity scenario and ALWAYS disposes the repository afterwards.
 *
 * `openRepository` hands back pack `FileHandle`s owned by the adapter's
 * filesystem, and `dispose()` is what closes them. Leaving that to garbage
 * collection is not merely untidy: Node reports a GC-closed `FileHandle` as a
 * deprecation warning, while Bun raises `ERR_INVALID_STATE` as an UNHANDLED
 * error — which its runner attributes to whichever unrelated test happens to
 * be in flight when the finalizer runs, so the failure surfaces far from the
 * scenario that actually leaked.
 *
 * Disposal is in a `finally` so a scenario that throws still releases its
 * handles; the throw itself propagates unchanged.
 */
import type { Repository } from '../../src/repository.ts';
import type { Scenario } from './scenarios/types.ts';

export const runScenario = async <TResult>(
  sut: Repository,
  scenario: Scenario<TResult>,
): Promise<TResult> => {
  try {
    return await scenario.run(sut, scenario.inputs);
  } finally {
    await sut.dispose();
  }
};

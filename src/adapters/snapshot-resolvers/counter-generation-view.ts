import type { GenerationView } from '../../ports/generation-view.js';
import type { WriteScope } from '../../ports/write-scope.js';

/**
 * Adapter-internal extension of `GenerationView` that exposes the write
 * side. Only the in-memory write-event bus (the sole owner of the view) is
 * permitted to call `bump`; readers see a plain `GenerationView`.
 *
 * Why: ADR-157 keeps Command and Query separated. `GenerationView` exposed
 * to the rest of the system has no mutator; this interface keeps `bump`
 * reachable for the bus without leaking it through the public port.
 */
export interface CounterGenerationView extends GenerationView {
  bump(scope: WriteScope): void;
}

const initialCounters = (): Record<WriteScope, number> => ({
  index: 0,
  refs: 0,
  objects: 0,
});

export const createCounterGenerationView = (): CounterGenerationView => {
  const counters = initialCounters();
  return {
    current: (scope) => counters[scope],
    bump: (scope) => {
      counters[scope] += 1;
    },
  };
};

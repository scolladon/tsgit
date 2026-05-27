import type { WriteScope } from './write-scope.js';

/**
 * Query side of the write-event triple (ADR-157). Read primitives depend on
 * this interface only — they query the current generation per scope but
 * cannot emit or subscribe.
 *
 * `current(scope)` is monotonic per scope: each successful `WriteEventEmitter.emit(scope)`
 * increments the corresponding counter exactly once. Scopes are independent
 * — `emit('index')` does not affect `current('refs')` or `current('objects')`.
 */
export interface GenerationView {
  current(scope: WriteScope): number;
}

import type { WriteScope } from './write-scope.js';

/**
 * Disposable handle returned from `WriteEventStream.subscribe`. Matches the
 * shape of TC39 Explicit Resource Management's `Disposable` so callers can
 * use `using` syntax once the project's TS target supports it.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Subscribe side of the write-event triple (ADR-157). Cache adapters depend
 * on this interface only — they observe events but cannot emit them.
 *
 * Subscribers receive identical event sequences regardless of subscription
 * order. Disposing a subscription removes the listener; the next event is
 * not delivered to that listener.
 */
export interface WriteEventStream {
  subscribe(listener: (scope: WriteScope) => void): Disposable;
}

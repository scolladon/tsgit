import type { WriteEventEmitter } from '../../ports/write-event-emitter.js';
import type { Disposable, WriteEventStream } from '../../ports/write-event-stream.js';
import type { WriteScope } from '../../ports/write-scope.js';
import type { CounterGenerationView } from './counter-generation-view.js';

type Listener = (scope: WriteScope) => void;

export interface InMemoryWriteEventBus {
  readonly emitter: WriteEventEmitter;
  readonly stream: WriteEventStream;
}

/**
 * Process-local implementation of the ADR-157 CQS triple. The single owner
 * is the repository factory; it hands `emitter` to write primitives and
 * `stream` + the bound `GenerationView` to read primitives.
 *
 * Lock-ordering contract (see `docs/understand/caching.md`): callers MUST
 * invoke `emitter.emit(scope)` AFTER the durable write succeeds but BEFORE
 * releasing any per-scope lock, so observers cannot read a stale snapshot
 * with the new generation already published.
 */
export const createInMemoryWriteEventBus = (view: CounterGenerationView): InMemoryWriteEventBus => {
  const listeners = new Set<Listener>();

  return {
    emitter: {
      emit: (scope) => {
        view.bump(scope);
        for (const fn of listeners) fn(scope);
      },
    },
    stream: {
      subscribe: (listener): Disposable => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
  };
};

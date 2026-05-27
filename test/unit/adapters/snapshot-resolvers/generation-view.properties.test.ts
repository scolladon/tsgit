import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';
import { createInMemoryWriteEventBus } from '../../../../src/adapters/snapshot-resolvers/in-memory-write-event-bus.js';
import type { WriteScope } from '../../../../src/ports/write-scope.js';
import { arbScopeHistory, arbWriteScope } from './arbitraries.js';

const countOccurrences = (history: readonly WriteScope[], scope: WriteScope): number =>
  history.reduce((total, value) => (value === scope ? total + 1 : total), 0);

describe('Given an arbitrary scope-emission history', () => {
  describe('When the history is replayed through the bus', () => {
    it('Then current(scope) equals the count of scope in the history (per-scope monotonic, scopes independent)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbScopeHistory(), (history) => {
          const view = createCounterGenerationView();
          const bus = createInMemoryWriteEventBus(view);
          for (const scope of history) {
            bus.emitter.emit(scope);
          }
          expect(view.current('index')).toBe(countOccurrences(history, 'index'));
          expect(view.current('refs')).toBe(countOccurrences(history, 'refs'));
          expect(view.current('objects')).toBe(countOccurrences(history, 'objects'));
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given two subscribers that join in arbitrary order before any emit', () => {
  describe('When the same scope history is replayed', () => {
    it('Then both subscribers receive identical scope sequences (delivery order independent of subscription order)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbScopeHistory(), (history) => {
          const view = createCounterGenerationView();
          const bus = createInMemoryWriteEventBus(view);
          const first: WriteScope[] = [];
          const second: WriteScope[] = [];
          bus.stream.subscribe((scope) => first.push(scope));
          bus.stream.subscribe((scope) => second.push(scope));
          for (const scope of history) {
            bus.emitter.emit(scope);
          }
          expect(first).toEqual(history);
          expect(second).toEqual(history);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary scope being emitted', () => {
  describe('When only that one scope is bumped', () => {
    it('Then other scopes remain at 0 (scope independence under any input)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbWriteScope(), (scope) => {
          const view = createCounterGenerationView();
          const bus = createInMemoryWriteEventBus(view);

          bus.emitter.emit(scope);

          const others = (['index', 'refs', 'objects'] as const).filter((s) => s !== scope);
          for (const other of others) {
            expect(view.current(other)).toBe(0);
          }
          expect(view.current(scope)).toBe(1);
        }),
        { numRuns: 200 },
      );
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';
import { createInMemoryWriteEventBus } from '../../../../src/adapters/snapshot-resolvers/in-memory-write-event-bus.js';
import type { WriteScope } from '../../../../src/ports/write-scope.js';

describe('createInMemoryWriteEventBus', () => {
  describe('Given a bus wired to a CounterGenerationView', () => {
    describe('When emitter.emit("index") is called', () => {
      it('Then the view advances current("index") from 0 to 1', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);

        // Act
        sut.emitter.emit('index');

        // Assert
        expect(view.current('index')).toBe(1);
      });

      it('Then the view leaves current("refs") and current("objects") at 0', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);

        // Act
        sut.emitter.emit('index');

        // Assert
        expect(view.current('refs')).toBe(0);
        expect(view.current('objects')).toBe(0);
      });
    });
  });

  describe('Given a single subscriber on the stream', () => {
    describe('When emitter.emit is called for each scope', () => {
      it('Then the listener receives the scope arguments in emission order', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);
        const listener = vi.fn();
        sut.stream.subscribe(listener);

        // Act
        sut.emitter.emit('index');
        sut.emitter.emit('refs');
        sut.emitter.emit('objects');

        // Assert
        expect(listener).toHaveBeenCalledTimes(3);
        expect(listener.mock.calls).toEqual([['index'], ['refs'], ['objects']]);
      });
    });
  });

  describe('Given two subscribers on the stream', () => {
    describe('When emitter.emit is called once', () => {
      it('Then both subscribers receive the identical scope argument exactly once', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);
        const listenerA = vi.fn<(scope: WriteScope) => void>();
        const listenerB = vi.fn<(scope: WriteScope) => void>();
        sut.stream.subscribe(listenerA);
        sut.stream.subscribe(listenerB);

        // Act
        sut.emitter.emit('refs');

        // Assert
        expect(listenerA).toHaveBeenCalledTimes(1);
        expect(listenerA).toHaveBeenCalledWith('refs');
        expect(listenerB).toHaveBeenCalledTimes(1);
        expect(listenerB).toHaveBeenCalledWith('refs');
      });
    });
  });

  describe('Given a subscriber that has been disposed', () => {
    describe('When a subsequent emit happens', () => {
      it('Then the disposed listener is not invoked', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);
        const listener = vi.fn();
        const subscription = sut.stream.subscribe(listener);

        // Act
        subscription.dispose();
        sut.emitter.emit('index');

        // Assert
        expect(listener).not.toHaveBeenCalled();
      });

      it('Then remaining subscribers still receive events', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);
        const disposed = vi.fn();
        const surviving = vi.fn();
        const subscription = sut.stream.subscribe(disposed);
        sut.stream.subscribe(surviving);

        // Act
        subscription.dispose();
        sut.emitter.emit('refs');

        // Assert
        expect(disposed).not.toHaveBeenCalled();
        expect(surviving).toHaveBeenCalledWith('refs');
      });
    });
  });

  describe('Given an empty subscriber set', () => {
    describe('When emit is called', () => {
      it('Then the view still advances (bump runs before fan-out)', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);

        // Act
        sut.emitter.emit('objects');

        // Assert
        expect(view.current('objects')).toBe(1);
      });
    });
  });

  describe('Given a subscriber that observes view.current() inside its callback', () => {
    describe('When emit is processed', () => {
      it('Then current(scope) already reflects the bump (bump precedes fan-out)', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);
        let observed = -1;
        sut.stream.subscribe((scope) => {
          observed = view.current(scope);
        });

        // Act
        sut.emitter.emit('index');

        // Assert
        expect(observed).toBe(1);
      });
    });
  });

  describe('Given a subscription disposed twice', () => {
    describe('When dispose() is called a second time', () => {
      it('Then it is a no-op and does not throw', () => {
        // Arrange
        const view = createCounterGenerationView();
        const sut = createInMemoryWriteEventBus(view);
        const subscription = sut.stream.subscribe(vi.fn());

        // Act + Assert
        subscription.dispose();
        expect(() => {
          subscription.dispose();
        }).not.toThrow();
      });
    });
  });
});

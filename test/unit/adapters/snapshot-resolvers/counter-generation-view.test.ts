import { describe, expect, it } from 'vitest';

import { createCounterGenerationView } from '../../../../src/adapters/snapshot-resolvers/counter-generation-view.js';

describe('createCounterGenerationView', () => {
  describe('Given a freshly created CounterGenerationView', () => {
    describe('When current() is queried before any bump', () => {
      it('Then current("index") returns 0', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        const generation = sut.current('index');

        // Assert
        expect(generation).toBe(0);
      });

      it('Then current("refs") returns 0', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        const generation = sut.current('refs');

        // Assert
        expect(generation).toBe(0);
      });

      it('Then current("objects") returns 0', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        const generation = sut.current('objects');

        // Assert
        expect(generation).toBe(0);
      });
    });
  });

  describe('Given a CounterGenerationView that has received bump("index")', () => {
    describe('When current() is queried per scope', () => {
      it('Then current("index") returns 1', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        sut.bump('index');

        // Assert
        expect(sut.current('index')).toBe(1);
      });

      it('Then current("refs") is unaffected (still 0)', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        sut.bump('index');

        // Assert
        expect(sut.current('refs')).toBe(0);
      });

      it('Then current("objects") is unaffected (still 0)', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        sut.bump('index');

        // Assert
        expect(sut.current('objects')).toBe(0);
      });
    });
  });

  describe('Given a CounterGenerationView bumped 3 times on "refs"', () => {
    describe('When current("refs") is queried', () => {
      it('Then it returns 3 (monotonic, one increment per bump)', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        sut.bump('refs');
        sut.bump('refs');
        sut.bump('refs');

        // Assert
        expect(sut.current('refs')).toBe(3);
      });
    });
  });

  describe('Given a CounterGenerationView bumped across all three scopes', () => {
    describe('When current() is queried per scope', () => {
      it('Then each scope counter is independent', () => {
        // Arrange
        const sut = createCounterGenerationView();

        // Act
        sut.bump('index');
        sut.bump('index');
        sut.bump('refs');
        sut.bump('objects');
        sut.bump('objects');
        sut.bump('objects');

        // Assert
        expect(sut.current('index')).toBe(2);
        expect(sut.current('refs')).toBe(1);
        expect(sut.current('objects')).toBe(3);
      });
    });
  });
});

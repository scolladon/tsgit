import { describe, expect, it } from 'vitest';
import { limitFor } from '../../../../../src/application/primitives/internal/concurrency.js';
import type { Context } from '../../../../../src/ports/context.js';

const contextWith = (fields: Partial<Context>): Context => fields as unknown as Context;

describe('limitFor', () => {
  describe('Given a Context with no concurrency and no override', () => {
    describe('When resolving the cpuBound bucket', () => {
      it('Then it returns the safe floor', () => {
        // Arrange
        const ctx = contextWith({});
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(1);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then it returns the safe floor', () => {
        // Arrange
        const ctx = contextWith({});
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(4);
      });
    });
  });

  describe('Given a Context with derived limits and no override', () => {
    const ctx = contextWith({ concurrency: { cpuBound: 4, ioBound: 32 } });

    describe('When resolving the cpuBound bucket', () => {
      it("Then it returns the policy's cpuBound", () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(4);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it("Then it returns the policy's ioBound", () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(32);
      });
    });
  });

  describe('Given config.parallelism set as a bare number', () => {
    const ctx = contextWith({
      concurrency: { cpuBound: 4, ioBound: 32 },
      config: { parallelism: 2 },
    });

    describe('When resolving the cpuBound bucket', () => {
      it('Then the override wins over the derived cpuBound', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(2);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then the same override also wins over the derived ioBound', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(2);
      });
    });
  });

  describe('Given config.parallelism set as { cpu } only', () => {
    const ctx = contextWith({
      concurrency: { cpuBound: 4, ioBound: 32 },
      config: { parallelism: { cpu: 2 } },
    });

    describe('When resolving the cpuBound bucket', () => {
      it('Then cpuBound is overridden', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(2);
      });
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then ioBound keeps the derived value — the io member is absent', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(32);
      });
    });
  });

  describe('Given config.parallelism set as { io } only', () => {
    const ctx = contextWith({
      concurrency: { cpuBound: 4, ioBound: 32 },
      config: { parallelism: { io: 16 } },
    });

    describe('When resolving the ioBound bucket', () => {
      it('Then ioBound is overridden', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'ioBound');

        // Assert
        expect(result).toBe(16);
      });
    });

    describe('When resolving the cpuBound bucket', () => {
      it('Then cpuBound keeps the derived value — the cpu member is absent', () => {
        // Arrange
        const sut = limitFor;

        // Act
        const result = sut(ctx, 'cpuBound');

        // Assert
        expect(result).toBe(4);
      });
    });
  });
});

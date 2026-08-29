import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeMachineFacts } from '../../../../src/adapters/browser/browser-concurrency.js';

describe('nativeMachineFacts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Given navigator.hardwareConcurrency is present', () => {
    describe('When reading machine facts', () => {
      it('Then cores carries that value', () => {
        // Arrange
        vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.cores).toBe(8);
      });

      it('Then threadpoolWidth mirrors cores — streams are native, no libuv', () => {
        // Arrange
        vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.threadpoolWidth).toBe(8);
      });
    });
  });

  describe('Given navigator.hardwareConcurrency is absent', () => {
    describe('When reading machine facts', () => {
      it('Then cores defaults to 4', () => {
        // Arrange
        vi.stubGlobal('navigator', {});
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.cores).toBe(4);
      });

      it('Then threadpoolWidth defaults to 4', () => {
        // Arrange
        vi.stubGlobal('navigator', {});
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.threadpoolWidth).toBe(4);
      });
    });
  });
});

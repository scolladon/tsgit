import { describe, expect, it, vi } from 'vitest';

import { hooksFor, onMeasuredRun } from '../../../test/bench/support/bench-dsl.ts';

const noop = (): void => undefined;

describe('onMeasuredRun', () => {
  describe('Given a scenario teardown', () => {
    describe('When the hook fires after warmup', () => {
      it('Then the teardown is not called', () => {
        // Arrange
        const teardown = vi.fn();
        const sut = onMeasuredRun;

        // Act
        sut(teardown)('warmup');

        // Assert
        expect(teardown).not.toHaveBeenCalled();
      });
    });

    describe('When the hook fires after the measured run', () => {
      it('Then the teardown is called exactly once', () => {
        // Arrange
        const teardown = vi.fn();
        const sut = onMeasuredRun;

        // Act
        sut(teardown)('run');

        // Assert
        expect(teardown).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('hooksFor', () => {
  describe('Given a comparison without a teardown', () => {
    describe('When hooksFor routes it', () => {
      it('Then neither bench receives options', () => {
        // Arrange
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, baseline: noop });

        // Assert
        expect(result).toEqual({});
      });
    });
  });

  describe('Given a tsgit-only comparison with a teardown', () => {
    describe('When hooksFor routes it', () => {
      it('Then the tsgit bench carries the hook and there is no baseline entry', () => {
        // Arrange
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, teardown: noop });

        // Assert
        expect(result.tsgit?.teardown).toBeTypeOf('function');
        expect(Object.hasOwn(result, 'baseline')).toBe(false);
      });
    });
  });

  describe('Given a comparison with a baseline and a teardown', () => {
    describe('When hooksFor routes it', () => {
      it('Then only the baseline, the last bench to run, carries the hook', () => {
        // Arrange
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, baseline: noop, teardown: noop });

        // Assert
        expect(result.baseline?.teardown).toBeTypeOf('function');
        expect(Object.hasOwn(result, 'tsgit')).toBe(false);
      });
    });
  });
});

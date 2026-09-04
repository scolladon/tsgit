import { describe, expect, it, vi } from 'vitest';

import { hooksFor, onMeasuredRun } from '../../../test/bench/support/bench-dsl.ts';

const noop = (): void => undefined;
// The hook never reads its task argument, so no tinybench task is built for it.
const noTask = undefined;

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
      it('Then both benches receive throwing options and neither carries a teardown', () => {
        // Arrange
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop });

        // Assert
        expect(result.tsgit?.throws).toBe(true);
        expect(result.baseline?.throws).toBe(true);
        expect(result.tsgit?.teardown).toBeUndefined();
        expect(result.baseline?.teardown).toBeUndefined();
      });
    });
  });

  describe('Given a comparison with a baseline and no teardown', () => {
    describe('When hooksFor routes it', () => {
      it('Then both benches receive throwing options and neither carries a teardown', () => {
        // Arrange
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, baseline: noop });

        // Assert
        expect(result.tsgit?.throws).toBe(true);
        expect(result.baseline?.throws).toBe(true);
        expect(result.tsgit?.teardown).toBeUndefined();
        expect(result.baseline?.teardown).toBeUndefined();
      });
    });
  });

  describe('Given a tsgit-only comparison with a teardown', () => {
    describe('When hooksFor routes it', () => {
      it('Then the tsgit bench carries a hook that fires the teardown after the run only', async () => {
        // Arrange
        const teardown = vi.fn();
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, teardown });
        await result.tsgit?.teardown?.(noTask, 'warmup');
        const callsAfterWarmup = teardown.mock.calls.length;
        await result.tsgit?.teardown?.(noTask, 'run');

        // Assert
        expect(callsAfterWarmup).toBe(0);
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(result.baseline?.throws).toBe(true);
        expect(result.baseline?.teardown).toBeUndefined();
      });
    });
  });

  describe('Given a comparison with a baseline and a teardown', () => {
    describe('When hooksFor routes it', () => {
      it('Then only the baseline, the last bench to run, carries a hook that fires after its run', async () => {
        // Arrange
        const teardown = vi.fn();
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, baseline: noop, teardown });
        await result.baseline?.teardown?.(noTask, 'run');

        // Assert
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(result.tsgit?.throws).toBe(true);
        expect(result.tsgit?.teardown).toBeUndefined();
      });
    });
  });
});

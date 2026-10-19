import { describe, expect, it, vi } from 'vitest';

import { fixedRunOptions, hooksFor, onMeasuredRun } from '../../../test/bench/support/bench-dsl.ts';

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
        expect(result.tsgit?.throws).toBe(true);
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
        expect(result.baseline?.throws).toBe(true);
        expect(result.tsgit?.teardown).toBeUndefined();
      });
    });
  });
});

describe('fixedRunOptions', () => {
  describe('Given a fixed iteration budget', () => {
    describe('When the run options are built', () => {
      it('Then time is zeroed so exactly warmup plus measured calls run', () => {
        // Arrange
        const sut = fixedRunOptions;

        // Act
        const result = sut({ warmup: 2, measured: 10 });

        // Assert
        expect(result).toEqual({ time: 0, warmupTime: 0, iterations: 10, warmupIterations: 2 });
      });
    });
  });
});

describe('hooksFor with fixed iterations', () => {
  describe('Given a baseline, a teardown and a fixed budget', () => {
    describe('When hooksFor routes it', () => {
      it('Then both benches carry the budget and throws, and the teardown rides on the baseline', async () => {
        // Arrange
        const teardown = vi.fn();
        const sut = hooksFor;

        // Act
        const result = sut({ sut: noop, baseline: noop, teardown }, { warmup: 1, measured: 3 });
        await result.baseline?.teardown?.(noTask, 'run');

        // Assert
        const budget = { time: 0, warmupTime: 0, iterations: 3, warmupIterations: 1 };
        expect(result.tsgit).toMatchObject({ ...budget, throws: true });
        expect(result.baseline).toMatchObject({ ...budget, throws: true });
        expect(result.tsgit?.teardown).toBeUndefined();
        expect(teardown).toHaveBeenCalledTimes(1);
      });
    });
  });
});

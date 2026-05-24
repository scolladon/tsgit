import { describe, expect, it, vi } from 'vitest';

import {
  createByteGranularityTracker,
  createGranularityTracker,
} from '../../../../../src/application/commands/internal/progress-tracker.js';
import type { ProgressReporter } from '../../../../../src/ports/progress-reporter.js';

const stubReporter = (): ProgressReporter => ({
  start: vi.fn(),
  update: vi.fn(),
  end: vi.fn(),
});

describe('createGranularityTracker', () => {
  describe('Given granularity 100 and 99 ticks', () => {
    describe('When ticked', () => {
      it('Then update is NEVER called (bucket never crossed)', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createGranularityTracker(reporter, 'op', 100);

        for (let i = 0; i < 99; i += 1) sut.tick();

        // Assert
        expect(reporter.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given granularity 100 and exactly 100 ticks', () => {
    describe('When ticked', () => {
      it('Then update is called once with current=100', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createGranularityTracker(reporter, 'op', 100);

        for (let i = 0; i < 100; i += 1) sut.tick();

        // Assert
        expect(reporter.update).toHaveBeenCalledTimes(1);
        expect(reporter.update).toHaveBeenCalledWith('op', 100);
      });
    });
  });

  describe('Given granularity 100 and 101 ticks', () => {
    describe('When ticked', () => {
      it('Then update fires once at 100 only (no final flush at 101)', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createGranularityTracker(reporter, 'op', 100);

        for (let i = 0; i < 101; i += 1) sut.tick();

        // Assert
        expect(reporter.update).toHaveBeenCalledTimes(1);
        expect(reporter.update).toHaveBeenCalledWith('op', 100);
      });
    });
  });

  describe('Given granularity 100 and 200 ticks', () => {
    describe('When ticked', () => {
      it('Then update fires twice (at 100 and 200)', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createGranularityTracker(reporter, 'op', 100);

        for (let i = 0; i < 200; i += 1) sut.tick();

        // Assert
        expect(reporter.update).toHaveBeenCalledTimes(2);
        expect(reporter.update).toHaveBeenNthCalledWith(1, 'op', 100);
        expect(reporter.update).toHaveBeenNthCalledWith(2, 'op', 200);
      });
    });
  });

  describe('Given a known total', () => {
    describe('When the bucket is crossed', () => {
      it('Then update is called with both current and total', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createGranularityTracker(reporter, 'op', 100, 250);

        for (let i = 0; i < 100; i += 1) sut.tick();

        // Assert
        expect(reporter.update).toHaveBeenCalledWith('op', 100, 250);
      });
    });
  });
});

describe('createByteGranularityTracker', () => {
  describe('Given byte granularity 65536 and 65535 bytes added', () => {
    describe('When ticked', () => {
      it('Then update is NEVER called (boundary not crossed)', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createByteGranularityTracker(reporter, 'push:upload', 65536);

        sut.add(65535);

        // Assert
        expect(reporter.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given byte granularity 65536 and exactly 65536 bytes added', () => {
    describe('When ticked', () => {
      it('Then update fires once at current=65536', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createByteGranularityTracker(reporter, 'push:upload', 65536);

        sut.add(65536);

        // Assert
        expect(reporter.update).toHaveBeenCalledTimes(1);
        expect(reporter.update).toHaveBeenCalledWith('push:upload', 65536);
      });
    });
  });

  describe('Given byte granularity 65536 and 65537 bytes added', () => {
    describe('When ticked', () => {
      it('Then update fires once at 65536 only', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createByteGranularityTracker(reporter, 'push:upload', 65536);

        sut.add(65537);

        // Assert
        expect(reporter.update).toHaveBeenCalledTimes(1);
        expect(reporter.update).toHaveBeenCalledWith('push:upload', 65537);
      });
    });
  });

  describe('Given two adds that together cross a boundary', () => {
    describe('When the second add lands', () => {
      it('Then update fires with the cumulative count', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createByteGranularityTracker(reporter, 'push:upload', 65536);

        sut.add(40000);
        sut.add(30000);

        // Assert
        expect(reporter.update).toHaveBeenCalledTimes(1);
        expect(reporter.update).toHaveBeenCalledWith('push:upload', 70000);
      });
    });
  });

  describe('Given a known total', () => {
    describe('When the bucket is crossed', () => {
      it('Then update receives current and total', () => {
        // Arrange
        const reporter = stubReporter();
        const sut = createByteGranularityTracker(reporter, 'push:upload', 65536, 200_000);

        sut.add(65536);

        // Assert
        expect(reporter.update).toHaveBeenCalledWith('push:upload', 65536, 200_000);
      });
    });
  });
});

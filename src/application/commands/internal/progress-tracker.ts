import type { ProgressReporter } from '../../../ports/progress-reporter.js';

/**
 * Bucket-crossing granularity tracker shared by every long-running command's
 * progress wiring. Increments a count and emits a `progress.update(op, count)`
 * only when the count crosses a multiple of `granularity`. Stateful, so the
 * caller creates one instance per `start`/`end` pair.
 *
 * Intentionally does NOT emit a final-flush update (i.e., the design's
 * "OR current === total" clause). Most operations report indeterminate
 * progress (`total: undefined`); commands that DO know `total` upfront pass it
 * to `start(op, total)` so reporters can render a percentage even without a
 * final update at the exact total.
 */
interface GranularityTracker {
  /** Increment and emit a bucket-crossing update if the boundary has been crossed. */
  readonly tick: () => void;
}

export const createGranularityTracker = (
  reporter: ProgressReporter,
  op: string,
  granularity: number,
  total?: number,
): GranularityTracker => {
  let count = 0;
  let lastEmittedBucket = 0;
  return {
    tick: (): void => {
      count += 1;
      const bucket = Math.floor(count / granularity);
      if (bucket > lastEmittedBucket) {
        lastEmittedBucket = bucket;
        if (total !== undefined) reporter.update(op, count, total);
        else reporter.update(op, count);
      }
    },
  };
};

/**
 * Byte-granularity variant for `push:upload` and similar streamed payload
 * progress. Same bucket-crossing rule applied to a running byte counter.
 */
interface ByteGranularityTracker {
  readonly add: (bytes: number) => void;
}

export const createByteGranularityTracker = (
  reporter: ProgressReporter,
  op: string,
  granularity: number,
  total?: number,
): ByteGranularityTracker => {
  let bytesSeen = 0;
  let lastEmittedBucket = 0;
  return {
    add: (bytes: number): void => {
      bytesSeen += bytes;
      const bucket = Math.floor(bytesSeen / granularity);
      if (bucket > lastEmittedBucket) {
        lastEmittedBucket = bucket;
        if (total !== undefined) reporter.update(op, bytesSeen, total);
        else reporter.update(op, bytesSeen);
      }
    },
  };
};

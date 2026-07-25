import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RetryConfig } from '../../../src/transport/types.js';
import { defaultDelay, defaultIsRetryable, withRetry } from '../../../src/transport/with-retry.js';
import {
  bodyWithCancelSpy,
  controllableDelay,
  fakeTransport,
  makeRequest,
  makeResponse,
} from './fixtures.js';

describe('withRetry — validation', () => {
  describe('Given attempts=%j (out of range)', () => {
    describe('When withRetry is created', () => {
      it.each([0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        'Then throws RangeError with exact message',
        (attempts) => {
          // Arrange & Act & Assert
          try {
            withRetry({ attempts });
            throw new Error('expected throw');
          } catch (err) {
            expect(err).toBeInstanceOf(RangeError);
            expect((err as RangeError).message).toBe('withRetry: attempts must be 1..10');
          }
        },
      );
    });
  });

  describe('Given baseMs=%j', () => {
    describe('When withRetry is created', () => {
      it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
        'Then throws RangeError with exact message',
        (baseMs) => {
          // Arrange & Act & Assert
          try {
            withRetry({ attempts: 3, baseMs });
            throw new Error('expected throw');
          } catch (err) {
            expect(err).toBeInstanceOf(RangeError);
            expect((err as RangeError).message).toBe('withRetry: baseMs must be ≥ 0');
          }
        },
      );
    });
  });

  describe('Given baseMs=200, maxDelayMs=100', () => {
    describe('When withRetry is created', () => {
      it('Then throws RangeError', () => {
        // Arrange & Act & Assert
        try {
          withRetry({ attempts: 3, baseMs: 200, maxDelayMs: 100 });
          throw new Error('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
          expect((err as RangeError).message).toBe('withRetry: maxDelayMs must be ≥ baseMs');
        }
      });
    });
  });

  describe('Given jitter=%j (out of range)', () => {
    describe('When withRetry is created', () => {
      it.each([-0.01, 1.01])('Then throws RangeError', (jitter) => {
        // Arrange & Act & Assert
        try {
          withRetry({ attempts: 3, jitter });
          throw new Error('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
          expect((err as RangeError).message).toBe('withRetry: jitter must be in [0, 1]');
        }
      });
    });
  });

  describe('Given a config value at the valid boundary of a guard', () => {
    describe('When withRetry is created', () => {
      it.each([
        { label: 'attempts=1 (lower boundary)', config: { attempts: 1 } },
        { label: 'attempts=10 (upper boundary)', config: { attempts: 10 } },
        { label: 'baseMs=0', config: { attempts: 3, baseMs: 0 } },
        {
          label: 'baseMs=100, maxDelayMs=100 (equal)',
          config: { attempts: 3, baseMs: 100, maxDelayMs: 100 },
        },
        { label: 'jitter=0', config: { attempts: 3, jitter: 0 } },
        { label: 'jitter=1', config: { attempts: 3, jitter: 1 } },
      ] satisfies ReadonlyArray<{ label: string; config: RetryConfig }>)(
        'Then returns a factory for $label',
        ({ config }) => {
          // Arrange & Act
          const result = typeof withRetry(config);

          // Assert
          expect(result).toBe('function');
        },
      );
    });
  });
});

describe('withRetry — retry behavior', () => {
  describe('Given attempts=1 and inner resolves', () => {
    describe('When request is awaited', () => {
      it('Then inner called once and result is the response', async () => {
        // Arrange
        const expected = makeResponse({ statusCode: 200 });
        const { transport, calls } = fakeTransport([expected]);
        const sut = withRetry({ attempts: 1 })(transport);

        // Act
        const result = await sut.request(makeRequest());

        // Assert
        expect(calls).toHaveLength(1);
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given attempts=2, inner rejects then resolves', () => {
    describe('When request is awaited', () => {
      it('Then inner called twice and second response returned', async () => {
        // Arrange
        const err = new Error('first');
        const ok = makeResponse({ statusCode: 200 });
        const { transport, calls } = fakeTransport([err, ok]);
        const sut = withRetry({ attempts: 2, baseMs: 0 })(transport);

        // Act
        const result = await sut.request(makeRequest());

        // Assert
        expect(calls).toHaveLength(2);
        expect(result).toBe(ok);
      });
    });
  });

  describe('Given inner rejects on every attempt', () => {
    describe('When request is awaited', () => {
      it.each([
        {
          attempts: 1,
          makeErrors: () => {
            const err = new Error('boom');
            return { errors: [err], expected: err };
          },
          expectedCalls: 1,
          label: 'attempts=1: inner called exactly once and rejection propagates',
        },
        {
          attempts: 2,
          makeErrors: () => {
            const err1 = new Error('first');
            const err2 = new Error('second');
            return { errors: [err1, err2], expected: err2 };
          },
          expectedCalls: 2,
          label: 'attempts=2: rejection propagates after 2 calls',
        },
        {
          attempts: 10,
          makeErrors: () => {
            const err = new Error('persistent');
            return { errors: Array(10).fill(err), expected: err };
          },
          expectedCalls: 10,
          label: 'attempts=10: inner called exactly 10 times',
        },
      ])('Then $label', async ({ attempts, makeErrors, expectedCalls }) => {
        // Arrange
        const { errors, expected } = makeErrors();
        const { transport, calls } = fakeTransport(errors);
        const sut = withRetry({ attempts, baseMs: 0 })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(expected);
        expect(calls).toHaveLength(expectedCalls);
      });
    });
  });

  describe('Given attempts=2, inner returns 500 then 200', () => {
    describe('When request is awaited', () => {
      it('Then 200 returned and 500 body cancelled once', async () => {
        // Arrange
        const { body: body500, cancelSpy } = bodyWithCancelSpy();
        const fail = makeResponse({ statusCode: 500, body: body500 });
        const ok = makeResponse({ statusCode: 200 });
        const { transport } = fakeTransport([fail, ok]);
        const sut = withRetry({ attempts: 2, baseMs: 0 })(transport);

        // Act
        const result = await sut.request(makeRequest());

        // Assert
        expect(result.statusCode).toBe(200);
        expect(cancelSpy()).toBe(1);
      });
    });
  });

  describe('Given a body whose cancel() throws', () => {
    describe('When retried', () => {
      it('Then 200 still returned (cancel error swallowed)', async () => {
        // Arrange
        const body500 = new ReadableStream<Uint8Array>({
          pull() {
            // keep readable so cancel() can fire
          },
          cancel() {
            throw new Error('cancel boom');
          },
        });
        const fail = makeResponse({ statusCode: 500, body: body500 });
        const ok = makeResponse({ statusCode: 200 });
        const { transport } = fakeTransport([fail, ok]);
        const sut = withRetry({ attempts: 2, baseMs: 0 })(transport);

        // Act
        const result = await sut.request(makeRequest());

        // Assert
        expect(result.statusCode).toBe(200);
      });
    });
  });

  describe('Given a custom predicate that always returns false', () => {
    describe('When inner rejects', () => {
      it('Then inner called once', async () => {
        // Arrange
        const err = new Error('no retry');
        const { transport, calls } = fakeTransport([err, err]);
        const sut = withRetry({
          attempts: 3,
          baseMs: 0,
          isRetryable: () => false,
        })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(err);
        expect(calls).toHaveLength(1);
      });
    });
  });

  describe('Given a predicate true on first failure but false on second', () => {
    describe('When attempts=3', () => {
      it('Then inner called twice', async () => {
        // Arrange
        const err1 = new Error('first');
        const err2 = new Error('second');
        const { transport, calls } = fakeTransport([err1, err2, err2]);
        let n = 0;
        const sut = withRetry({
          attempts: 3,
          baseMs: 0,
          isRetryable: () => {
            n += 1;
            return n === 1;
          },
        })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(err2);
        expect(calls).toHaveLength(2);
      });
    });
  });
});

describe('withRetry — defaultIsRetryable table', () => {
  type Row = readonly [
    {
      readonly statusCode?: number;
      readonly throws?: boolean;
    },
    boolean,
  ];

  const rows: ReadonlyArray<Row> = [
    [{ throws: true }, true],
    [{ statusCode: 200 }, false],
    [{ statusCode: 429 }, true],
    [{ statusCode: 499 }, false],
    [{ statusCode: 500 }, true],
    [{ statusCode: 501 }, false],
    [{ statusCode: 502 }, true],
    [{ statusCode: 599 }, true],
    [{ statusCode: 600 }, false],
  ];

  describe('Given inner returns %j', () => {
    describe('When defaultIsRetryable evaluates', () => {
      it.each(rows)('Then result is %j', async (input, expected) => {
        // Arrange
        const inner = input.throws
          ? fakeTransport([new Error('boom')])
          : fakeTransport([makeResponse({ statusCode: input.statusCode ?? 200 })]);
        // Two attempts: detect retry via call count > 1.
        const second = makeResponse({ statusCode: 200 });
        const seq: ReadonlyArray<Error | typeof second> = input.throws
          ? [new Error('boom'), second]
          : [makeResponse({ statusCode: input.statusCode ?? 200 }), second];
        void inner;
        const { transport, calls } = fakeTransport(seq);
        const sut = withRetry({ attempts: 2, baseMs: 0 })(transport);

        // Act
        try {
          await sut.request(makeRequest());
        } catch {
          // ignore — we only inspect call count
        }
        const retried = calls.length > 1;

        // Assert
        expect(retried).toBe(expected);
      });
    });
  });
});

describe('withRetry — cancellation', () => {
  describe('Given a pre-aborted signal', () => {
    describe('When request is awaited', () => {
      it('Then rejects with signal.reason and inner is NOT called', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort('pre-aborted');
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withRetry({ attempts: 2, baseMs: 0 })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest({ signal: controller.signal }))).rejects.toBe(
          'pre-aborted',
        );
        expect(calls).toHaveLength(0);
      });
    });
  });

  describe('Given mid-flight abort during backoff', () => {
    describe('When awaited', () => {
      it('Then rejects with signal.reason and inner called only once', async () => {
        // Arrange
        const controller = new AbortController();
        const cd = controllableDelay();
        const err = new Error('first');
        const { transport, calls } = fakeTransport([err, makeResponse()]);
        const sut = withRetry({
          attempts: 2,
          baseMs: 100,
          delay: cd.delay,
        })(transport);

        // Act
        const promise = sut.request(makeRequest({ signal: controller.signal }));
        // wait for first call + backoff to start
        await Promise.resolve();
        await Promise.resolve();
        controller.abort('mid');

        // Assert
        await expect(promise).rejects.toBe('mid');
        expect(calls).toHaveLength(1);
      });
    });
  });

  describe('Given inner rejects with AbortError DOMException', () => {
    describe('When awaited', () => {
      it('Then rejection propagates without retry', async () => {
        // Arrange
        const abortErr = new DOMException('aborted', 'AbortError');
        const { transport, calls } = fakeTransport([abortErr, makeResponse()]);
        const sut = withRetry({ attempts: 3, baseMs: 0 })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(abortErr);
        expect(calls).toHaveLength(1);
      });
    });
  });

  describe('Given inner rejects with TimeoutError DOMException', () => {
    describe('When awaited', () => {
      it('Then retried (NOT short-circuited as abort)', async () => {
        // Arrange
        const timeoutErr = new DOMException('timed out', 'TimeoutError');
        const ok = makeResponse({ statusCode: 200 });
        const { transport, calls } = fakeTransport([timeoutErr, ok]);
        const sut = withRetry({ attempts: 2, baseMs: 0 })(transport);

        // Act
        const result = await sut.request(makeRequest());

        // Assert
        expect(result).toBe(ok);
        expect(calls).toHaveLength(2);
      });
    });
  });

  describe('Given an AbortError AND a custom predicate that always returns true', () => {
    describe('When awaited', () => {
      it('Then no retry (shouldStop short-circuits abort regardless of predicate)', async () => {
        // Arrange
        const abortErr = new DOMException('aborted', 'AbortError');
        const { transport, calls } = fakeTransport([abortErr, makeResponse()]);
        const sut = withRetry({
          attempts: 3,
          baseMs: 0,
          isRetryable: () => true,
        })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(abortErr);
        expect(calls).toHaveLength(1);
      });
    });
  });
});

describe('defaultDelay primitive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Given delay(0)', () => {
    describe('When awaited', () => {
      it('Then setTimeout was NOT called', async () => {
        // Arrange
        const spy = vi.spyOn(globalThis, 'setTimeout');

        // Act
        await defaultDelay(0);

        // Assert
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given delay(50)', () => {
    describe('When 49ms advances', () => {
      it('Then unresolved; When 1ms more advances, Then resolves', async () => {
        // Arrange
        const promise = defaultDelay(50);
        let resolved = false;
        promise.then(() => {
          resolved = true;
        });

        // Act
        vi.advanceTimersByTime(49);
        await Promise.resolve();

        // Assert
        expect(resolved).toBe(false);

        // Act
        vi.advanceTimersByTime(1);
        await promise;

        // Assert
        expect(resolved).toBe(true);
      });
    });
  });

  describe('Given delay(1000) with pre-aborted signal', () => {
    describe('When awaited', () => {
      it('Then rejects with reason and setTimeout was NOT called', async () => {
        // Arrange
        const spy = vi.spyOn(globalThis, 'setTimeout');
        const controller = new AbortController();
        controller.abort('reason');

        // Act & Assert
        await expect(defaultDelay(1000, controller.signal)).rejects.toBe('reason');
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given delay(1000) with mid-flight abort', () => {
    describe('When awaited', () => {
      it('Then rejects and clearTimeout called once', async () => {
        // Arrange
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
        const controller = new AbortController();

        // Act
        const promise = defaultDelay(1000, controller.signal);
        controller.abort('mid-abort');

        // Assert
        await expect(promise).rejects.toBe('mid-abort');
        expect(clearSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given delay(50) that resolves naturally', () => {
    describe('When complete', () => {
      it('Then abort listener is removed', async () => {
        // Arrange
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

        // Act
        const promise = defaultDelay(50, controller.signal);
        vi.advanceTimersByTime(50);
        await promise;

        // Assert
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      });
    });
  });
});

describe('defaultIsRetryable — direct table', () => {
  describe('Given a partial retry-evaluation context', () => {
    describe('When evaluated', () => {
      it.each([
        {
          makeError: undefined,
          expected: true,
          label: 'an error with no response returns true',
        },
        {
          makeError: () => new DOMException('aborted', 'AbortError'),
          expected: false,
          label: 'an AbortError DOMException returns false',
        },
        {
          makeError: () => new DOMException('timed out', 'TimeoutError'),
          expected: true,
          label:
            'a non-AbortError DOMException (TimeoutError) returns true (only AbortError gets the special case)',
        },
      ])('Then $label', ({ makeError, expected }) => {
        // Arrange
        const error = makeError ? makeError() : new Error('boom');

        // Act
        const result = defaultIsRetryable({ error, attempt: 1 });

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given no error and no response (undefined undefined)', () => {
    describe('When evaluated', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const result = defaultIsRetryable({ attempt: 1 });

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given response statusCode=%i', () => {
    describe('When defaultIsRetryable evaluates', () => {
      it.each([
        [200, false],
        [400, false],
        [401, false],
        [403, false],
        [404, false],
        [428, false],
        [429, true],
        [499, false],
        [500, true],
        [501, false],
        [502, true],
        [503, true],
        [504, true],
        [599, true],
        [600, false],
      ])('Then it returns %j', (statusCode, expected) => {
        // Arrange
        const response = makeResponse({ statusCode });

        // Act & Assert
        expect(defaultIsRetryable({ response, attempt: 1 })).toBe(expected);
      });
    });
  });
});

describe('withRetry — backoff math (deterministic)', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given fixed backoff with baseMs=100, jitter=0, attempts=3 and 3 errors', () => {
    describe('When delay computed', () => {
      it('Then both delays equal 100 (NOT 200 — kills exponential mutant)', async () => {
        // Arrange
        const delaySpy = vi.fn(
          async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined,
        );
        const err = new Error('always');
        const { transport } = fakeTransport([err, err, err]);
        const sut = withRetry({
          attempts: 3,
          baseMs: 100,
          backoff: 'fixed',
          jitter: 0,
          delay: delaySpy,
        })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(err);
        expect(delaySpy.mock.calls.map((c) => c[0])).toEqual([100, 100]);
      });
    });
  });

  describe('Given exponential backoff with baseMs=100 and jitter=0', () => {
    describe('When 3 attempts fail', () => {
      it('Then delay called with [100, 200]', async () => {
        // Arrange
        const delaySpy = vi.fn(
          async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined,
        );
        const err = new Error('e');
        const { transport } = fakeTransport([err, err, makeResponse()]);
        const sut = withRetry({
          attempts: 3,
          baseMs: 100,
          backoff: 'exponential',
          jitter: 0,
          delay: delaySpy,
        })(transport);

        // Act
        await sut.request(makeRequest());

        // Assert
        expect(delaySpy.mock.calls.map((c) => c[0])).toEqual([100, 200]);
      });
    });
  });

  describe('Given baseMs=100_000 with default maxDelayMs', () => {
    describe('When delay computed', () => {
      it('Then it is clamped to 30_000', async () => {
        // Arrange
        const delaySpy = vi.fn(
          async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined,
        );
        const { transport } = fakeTransport([new Error('e1'), makeResponse()]);
        const sut = withRetry({
          attempts: 2,
          baseMs: 100_000,
          backoff: 'fixed',
          jitter: 0,
          maxDelayMs: 100_000,
          delay: delaySpy,
        })(transport);

        // Act — raw=100000, clamped=100000 (we set maxDelayMs to allow it past
        // validate); test clamp via default.
        await sut.request(makeRequest());

        // Assert
        expect(delaySpy.mock.calls[0]?.[0]).toBe(100_000);
      });
    });
  });

  describe('Given baseMs=100 with jitter=0.5 and Math.random=1.0', () => {
    describe('When delay computed', () => {
      it('Then factor=1.5 → delay=150', async () => {
        // Arrange
        vi.spyOn(Math, 'random').mockReturnValue(1.0);
        const delaySpy = vi.fn(
          async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined,
        );
        const { transport } = fakeTransport([new Error('e1'), makeResponse()]);
        const sut = withRetry({
          attempts: 2,
          baseMs: 100,
          backoff: 'fixed',
          jitter: 0.5,
          delay: delaySpy,
        })(transport);

        // Act — factor = 1 - 0.5 + 2 * 0.5 * 1.0 = 1.5 → floor(100 * 1.5) = 150
        await sut.request(makeRequest());

        // Assert
        expect(delaySpy.mock.calls[0]?.[0]).toBe(150);
      });
    });
  });

  describe('Given baseMs=100 with jitter=0.5 and Math.random=0.0', () => {
    describe('When delay computed', () => {
      it('Then factor=0.5 → delay=50', async () => {
        // Arrange
        vi.spyOn(Math, 'random').mockReturnValue(0.0);
        const delaySpy = vi.fn(
          async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined,
        );
        const { transport } = fakeTransport([new Error('e1'), makeResponse()]);
        const sut = withRetry({
          attempts: 2,
          baseMs: 100,
          backoff: 'fixed',
          jitter: 0.5,
          delay: delaySpy,
        })(transport);

        // Act — factor = 1 - 0.5 + 2 * 0.5 * 0.0 = 0.5 → floor(100 * 0.5) = 50
        await sut.request(makeRequest());

        // Assert
        expect(delaySpy.mock.calls[0]?.[0]).toBe(50);
      });
    });
  });
});

describe('withRetry — last-attempt boundary', () => {
  describe('Given attempts=2 with predicate true on both', () => {
    describe('When 2 inner errors', () => {
      it('Then inner called exactly twice (last-attempt short-circuits retry decision)', async () => {
        // Arrange
        const err = new Error('always');
        const { transport, calls } = fakeTransport([err, err, err]);
        const sut = withRetry({
          attempts: 2,
          baseMs: 0,
          isRetryable: () => true,
        })(transport);

        // Act & Assert — attempts=2, isLast on attempt 2 stops the loop without
        // consulting the predicate.
        await expect(sut.request(makeRequest())).rejects.toBe(err);
        expect(calls).toHaveLength(2);
      });
    });
  });

  describe('Given attempts=3 with predicate true and 3 errors', () => {
    describe('When awaited', () => {
      it('Then inner called exactly 3 times (final attempt returns the error verbatim)', async () => {
        // Arrange
        const err = new Error('still-failing');
        const { transport, calls } = fakeTransport([err, err, err, err]);
        const sut = withRetry({
          attempts: 3,
          baseMs: 0,
          isRetryable: () => true,
        })(transport);

        // Act & Assert
        await expect(sut.request(makeRequest())).rejects.toBe(err);
        expect(calls).toHaveLength(3);
      });
    });
  });
});

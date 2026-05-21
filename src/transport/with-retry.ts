import type { HttpRequest, HttpResponse, HttpTransport } from '../ports/http-transport.js';
import type { RetryConfig, RetryPredicate } from './types.js';

const ATTEMPTS_MIN = 1;
const ATTEMPTS_MAX = 10;
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER = 0.2;
const DEFAULT_BACKOFF: 'fixed' | 'exponential' = 'fixed';

const isNonRetryableStatus = (s: number): boolean =>
  s < 429 || (s > 429 && s < 500) || s === 501 || s >= 600;

export const defaultIsRetryable: RetryPredicate = ({ error, response }) => {
  if (response) return !isNonRetryableStatus(response.statusCode);
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error !== undefined;
};

const isAbortError = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

const validateAttempts = (attempts: number): void => {
  if (
    !Number.isFinite(attempts) ||
    !Number.isInteger(attempts) ||
    attempts < ATTEMPTS_MIN ||
    attempts > ATTEMPTS_MAX
  ) {
    throw new RangeError('withRetry: attempts must be 1..10');
  }
};

const validateBaseMs = (baseMs: number | undefined): void => {
  if (baseMs === undefined) return;
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError('withRetry: baseMs must be ≥ 0');
  }
};

const validateMaxDelay = (baseMs: number | undefined, maxDelayMs: number | undefined): void => {
  if (maxDelayMs === undefined) return;
  const base = baseMs ?? DEFAULT_BASE_MS;
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < base) {
    throw new RangeError('withRetry: maxDelayMs must be ≥ baseMs');
  }
};

const validateJitter = (jitter: number | undefined): void => {
  if (jitter === undefined) return;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new RangeError('withRetry: jitter must be in [0, 1]');
  }
};

const tryCancelBody = (body: ReadableStream<Uint8Array> | undefined): void => {
  if (!body) return;
  try {
    body.cancel().catch(() => {
      /* swallow */
    });
  } catch {
    // swallow synchronous throw too
  }
};

export const defaultDelay = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // Stryker disable next-line ConditionalExpression: equivalent — `timer` is assigned synchronously by the `setTimeout` call below before `addEventListener` registers `onAbort`, so by the time the abort listener can fire `timer` is always defined.
      if (timer !== undefined) clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — `onAbort` settles the promise on its first (and only) firing; AbortSignal aborts at most once and the natural-resolve path also calls `removeEventListener`, so dropping `once` only leaves a listener on an already-settled signal with no observable effect.
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
};

const computeDelay = (attempt: number, config: RetryConfig): number => {
  const baseMs = config.baseMs ?? DEFAULT_BASE_MS;
  const backoff = config.backoff ?? DEFAULT_BACKOFF;
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = config.jitter ?? DEFAULT_JITTER;
  const raw = backoff === 'exponential' ? baseMs * 2 ** (attempt - 1) : baseMs;
  const clamped = Math.min(raw, maxDelayMs);
  const factor = 1 - jitter + 2 * jitter * Math.random();
  return Math.floor(clamped * factor);
};

const validateConfig = (config: RetryConfig): void => {
  validateAttempts(config.attempts);
  validateBaseMs(config.baseMs);
  validateMaxDelay(config.baseMs, config.maxDelayMs);
  validateJitter(config.jitter);
};

interface AttemptOutcome {
  readonly response?: HttpResponse;
  readonly error?: unknown;
}

const performAttempt = async (inner: HttpTransport, req: HttpRequest): Promise<AttemptOutcome> => {
  try {
    return { response: await inner.request(req) };
  } catch (error) {
    return { error };
  }
};

const buildRetryArgs = (outcome: AttemptOutcome, attempt: number): Parameters<RetryPredicate>[0] =>
  outcome.response !== undefined
    ? { response: outcome.response, attempt }
    : { error: outcome.error, attempt };

const finalize = (outcome: AttemptOutcome): HttpResponse => {
  if (outcome.response !== undefined) return outcome.response;
  throw outcome.error;
};

interface AttemptContext {
  readonly attempt: number;
  readonly isLast: boolean;
  readonly outcome: AttemptOutcome;
}

const shouldStop = (ctx: AttemptContext, isRetryable: RetryPredicate): boolean => {
  // Stryker disable next-line ConditionalExpression: equivalent — `isAbortError` returns false for `undefined` (`undefined instanceof DOMException` is false), so `error !== undefined && isAbortError(error)` is exactly `isAbortError(error)`; replacing the left operand with `true` cannot change the result.
  if (ctx.outcome.error !== undefined && isAbortError(ctx.outcome.error)) return true;
  if (ctx.isLast) return true;
  return !isRetryable(buildRetryArgs(ctx.outcome, ctx.attempt));
};

export const withRetry = (config: RetryConfig) => {
  validateConfig(config);
  const isRetryable = config.isRetryable ?? defaultIsRetryable;
  const delay = config.delay ?? defaultDelay;
  return (inner: HttpTransport): HttpTransport => {
    const request = async (req: HttpRequest): Promise<HttpResponse> => {
      if (req.signal?.aborted) throw req.signal.reason;
      let outcome: AttemptOutcome = {};
      for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
        outcome = await performAttempt(inner, req);
        const ctx: AttemptContext = {
          attempt,
          isLast: attempt === config.attempts,
          outcome,
        };
        if (shouldStop(ctx, isRetryable)) return finalize(outcome);
        if (outcome.response !== undefined) tryCancelBody(outcome.response.body);
        await delay(computeDelay(attempt, config), req.signal);
      }
      return finalize(outcome);
    };
    return { request };
  };
};

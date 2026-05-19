import { sanitize } from '../domain/commands/error.js';

/**
 * General-purpose level-based logger consumed by the facade and any cross-cutting
 * concern (dispose, validation, lifecycle). Independent from the transport-tier
 * `Logger` in `transport/types.ts`, which is event-based and HTTP-shaped.
 *
 * The facade wraps user-supplied loggers with sanitization at construction time
 * . Implementations should be tolerant of high call
 * frequency and MUST NOT throw — a throwing logger crashes nothing.
 */
export interface Logger {
  readonly debug?: (message: string, context?: Readonly<Record<string, unknown>>) => void;
  readonly info?: (message: string, context?: Readonly<Record<string, unknown>>) => void;
  readonly warn?: (message: string, context?: Readonly<Record<string, unknown>>) => void;
  readonly error?: (message: string, context?: Readonly<Record<string, unknown>>) => void;
}

/** No-op Logger — every level method is absent (callers use optional chaining). */
export const noopLogger: Logger = Object.freeze({});

/**
 * Wrap a user-supplied logger so every `message` + every string value in the
 * `context` object passes through `sanitize()` before reaching
 * the sink. the facade applies this at construction time so no
 * downstream caller ever feeds raw control bytes to a user-controlled sink.
 *
 * Methods that the user did not supply are absent on the wrapper (preserves
 * the optional-method contract). Throws from the underlying sink are caught
 * and dropped — a faulty logger must not crash the operation.
 */
export const wrapLoggerSanitizer = (logger: Logger): Logger => {
  // Caller guarantees `method` is defined (we only call this on truthy levels);
  // the wrapper itself never returns undefined.
  const wrapLevel =
    (method: (m: string, c?: Readonly<Record<string, unknown>>) => void) =>
    (message: string, context?: Readonly<Record<string, unknown>>): void => {
      try {
        const safeMessage = sanitize(message);
        const safeContext = context !== undefined ? sanitizeContext(context) : undefined;
        method(safeMessage, safeContext);
      } catch {
        // swallow — loggers must never crash the caller
      }
    };
  const wrapped: Logger = {};
  if (logger.debug !== undefined)
    (wrapped as { debug?: Logger['debug'] }).debug = wrapLevel(logger.debug);
  if (logger.info !== undefined)
    (wrapped as { info?: Logger['info'] }).info = wrapLevel(logger.info);
  if (logger.warn !== undefined)
    (wrapped as { warn?: Logger['warn'] }).warn = wrapLevel(logger.warn);
  if (logger.error !== undefined)
    (wrapped as { error?: Logger['error'] }).error = wrapLevel(logger.error);
  return Object.freeze(wrapped);
};

const sanitizeContext = (
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = typeof value === 'string' ? sanitize(value) : value;
  }
  return out;
};

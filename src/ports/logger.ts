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
 * Wrap a user-supplied logger so every `message` + every string key and value in
 * the `context` object — arrays and plain objects walked to a bounded depth —
 * passes through `sanitize()` before reaching the sink. The facade applies this
 * at construction time so no downstream caller ever feeds raw control bytes to
 * a user-controlled sink.
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

/** Container levels walked, the context itself included; deeper containers are elided. */
const MAX_CONTEXT_NESTING = 16;
const TRUNCATED_MARKER = '[Truncated]';
const CIRCULAR_MARKER = '[Circular]';

type Ancestors = ReadonlySet<object>;

const isPlainObject = (value: object): value is Readonly<Record<string, unknown>> => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const sanitizeContext = (
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => sanitizeRecord(context, new Set([context]));

// Ancestors are the containers on the current path only, so a shared sibling is
// walked twice while a back-reference is cut; plain objects and arrays are the
// only containers walked — class instances (bytes, dates, errors) pass by identity.
const sanitizeValue = (value: unknown, ancestors: Ancestors): unknown => {
  if (typeof value === 'string') return sanitize(value);
  if (typeof value !== 'object' || value === null) return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  if (ancestors.has(value)) return CIRCULAR_MARKER;
  if (ancestors.size >= MAX_CONTEXT_NESTING) return TRUNCATED_MARKER;
  const path = new Set(ancestors).add(value);
  return isArray ? value.map((item) => sanitizeValue(item, path)) : sanitizeRecord(value, path);
};

// `fromEntries` defines own properties, so a `__proto__` key never reaches a setter.
const sanitizeRecord = (
  record: Readonly<Record<string, unknown>>,
  path: Ancestors,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [sanitize(key), sanitizeValue(value, path)]),
  );

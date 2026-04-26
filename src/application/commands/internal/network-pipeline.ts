import type { Context } from '../../../ports/context.js';
import type { HttpTransport } from '../../../ports/http-transport.js';
import {
  type AuthConfig,
  type LogEvent,
  type Logger,
  type RetryConfig,
  withAuth,
  withLogging,
  withRetry,
} from '../../../transport/index.js';

const DEFAULT_RETRY: RetryConfig = {
  attempts: 3,
  backoff: 'exponential',
  baseMs: 250,
  maxDelayMs: 5_000,
};

interface NetworkOpts {
  readonly auth?: AuthConfig;
  readonly retry?: RetryConfig;
  readonly logger?: Logger;
}

/**
 * Compose the standard network pipeline on top of `ctx.transport`:
 * (innermost) transport → withRetry → withAuth → withLogging (outermost).
 *
 * The logger is wrapped in a sanitizer ONCE so all middleware diagnostic events
 * pass through the same scrubber.
 *
 * Phase 10's facade is responsible for freezing `ctx.config`; this composer
 * does NOT mutate caller-owned objects. Callers depending on the freeze
 * invariant must construct their `ctx` with a frozen config.
 */
export const withDefaults = (ctx: Context, opts: NetworkOpts = {}): HttpTransport => {
  const safeLogger = opts.logger !== undefined ? wrapLoggerSanitizer(opts.logger) : undefined;
  // Composition order matters for security: withLogging is wrapped LAST so it
  // observes the request BEFORE withAuth injects the Authorization header. If
  // a future change weakens withLogging's redactor, credentials still never
  // appear in the log because they are added downstream of the logger.
  let result: HttpTransport = ctx.transport;
  result = withRetry(opts.retry ?? DEFAULT_RETRY)(result);
  if (opts.auth !== undefined) {
    result = withAuth(opts.auth)(result);
  }
  if (safeLogger !== undefined) {
    result = withLogging({ logger: safeLogger })(result);
  }
  return result;
};

/**
 * Wrap a `Logger` so every emitted event has its string fields scrubbed of
 * control bytes — preventing log-injection from adversarial response data.
 *
 * - `\t` (0x09) and `\n` (0x0A): preserved verbatim (most log backends format them).
 * - `\r` (0x0D): escaped as `\x0D` (the canonical log-injection vector).
 * - All other bytes outside `0x20`–`0x7E`: escaped as `\xNN` (uppercase hex).
 */
export const wrapLoggerSanitizer = (logger: Logger): Logger => ({
  log: (event) => logger.log(sanitizeEvent(event)),
});

const sanitizeEvent = (event: LogEvent): LogEvent => {
  if (event.kind === 'request') {
    return {
      ...event,
      url: sanitizeStr(event.url),
      headers: sanitizeHeaders(event.headers),
    };
  }
  if (event.kind === 'response') {
    return {
      ...event,
      url: sanitizeStr(event.url),
      headers: sanitizeHeaders(event.headers),
    };
  }
  return {
    ...event,
    url: sanitizeStr(event.url),
    errorMessage: sanitizeStr(event.errorMessage),
  };
};

const sanitizeHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = sanitizeStr(value);
  }
  return out;
};

const sanitizeStr = (value: string): string => {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a) {
      out += value[i];
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    } else {
      out += value[i];
    }
  }
  return out;
};

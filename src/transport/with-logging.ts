import type { HttpRequest, HttpResponse, HttpTransport } from '../ports/http-transport.js';
import type { LogEvent, Logger, LoggingConfig } from './types.js';

const FORCED_REDACT = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

const REDACT_QUERY_KEYS = /^(access[_-]?token|api[_-]?key|password|secret|token|sig|signature)$/i;

const redactHeaders = (
  headers: Readonly<Record<string, string>>,
  extra: ReadonlyArray<string>,
): Readonly<Record<string, string>> => {
  const extraLower = extra.map((h) => h.toLowerCase());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const low = k.toLowerCase();
    if (FORCED_REDACT.has(low) || extraLower.includes(low)) continue;
    out[k] = v;
  }
  return out;
};

const redactUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const keysToDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (REDACT_QUERY_KEYS.test(key)) keysToDelete.push(key);
  }
  for (const k of keysToDelete) parsed.searchParams.delete(k);
  return parsed.toString();
};

const safeLog = (logger: Logger, event: LogEvent): void => {
  try {
    logger.log(event);
  } catch {
    // swallow per design §5.3
  }
};

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err);
};

const buildRequestEvent = (
  req: HttpRequest,
  redactedUrl: string,
  headers: Readonly<Record<string, string>>,
): LogEvent => ({
  kind: 'request',
  method: req.method,
  url: redactedUrl,
  headers,
  bodyBytes: req.body?.byteLength ?? 0,
});

const buildResponseEvent = (
  res: HttpResponse,
  redactedUrl: string,
  elapsedMs: number,
  headers: Readonly<Record<string, string>>,
): LogEvent => ({
  kind: 'response',
  statusCode: res.statusCode,
  url: redactedUrl,
  elapsedMs,
  headers,
});

const buildErrorEvent = (redactedUrl: string, elapsedMs: number, err: unknown): LogEvent => ({
  kind: 'error',
  url: redactedUrl,
  elapsedMs,
  errorMessage: errorMessage(err),
});

export const withLogging = (config: LoggingConfig) => {
  const now = config.now ?? (() => performance.now());
  const extraRedact = config.redactHeaders ?? [];
  return (inner: HttpTransport): HttpTransport => ({
    request: async (req) => {
      const redactedUrl = redactUrl(req.url);
      const safeHeaders = redactHeaders(req.headers, extraRedact);
      const start = now();
      safeLog(config.logger, buildRequestEvent(req, redactedUrl, safeHeaders));
      try {
        const res = await inner.request(req);
        const safeResHeaders = redactHeaders(res.headers, extraRedact);
        safeLog(config.logger, buildResponseEvent(res, redactedUrl, now() - start, safeResHeaders));
        return res;
      } catch (err) {
        safeLog(config.logger, buildErrorEvent(redactedUrl, now() - start, err));
        throw err;
      }
    },
  });
};

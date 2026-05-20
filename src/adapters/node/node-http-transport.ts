import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { networkError } from '../../domain/index.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../ports/http-transport.js';

export interface NodeHttpTransportOptions {
  readonly allowInsecureHttp?: boolean;
}

/**
 * Lowercase keys and coerce header values to strings, dropping entries whose value is undefined.
 * Exported so every branch can be exercised directly by unit tests.
 * @internal
 */
export function normalizeHeaders(
  rawHeaders: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** @internal Exported for unit coverage of every errno branch. */
export function sanitizeErrorReason(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return 'DNS resolution failed';
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ETIMEDOUT':
      return 'Connection timed out';
    default:
      // Static fallback — never echo raw err.code. Even seemingly-benign codes (EPROTO,
      // ECONNRESET, EHOSTUNREACH) can leak TLS configuration or topology details to probes.
      return 'network error';
  }
}

export class NodeHttpTransport implements HttpTransport {
  private readonly allowInsecureHttp: boolean;

  constructor(options: NodeHttpTransportOptions = {}) {
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
  }

  request = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    if (url.protocol === 'http:' && !this.allowInsecureHttp) {
      throw networkError('HTTPS required — set allowInsecureHttp to allow plaintext HTTP');
    }
    const client = url.protocol === 'https:' ? https : http;
    return new Promise<HttpResponse>((resolve, reject) => {
      const requestOptions: http.RequestOptions = {
        method: req.method,
        headers: { ...req.headers },
      };
      // Stryker disable next-line ConditionalExpression: equivalent — forcing this to `true` assigns `requestOptions.signal = undefined` when no signal was given, which Node's http treats identically to never setting the property.
      if (req.signal !== undefined) {
        requestOptions.signal = req.signal;
      }
      const clientRequest = client.request(url, requestOptions, (res) => {
        // Node invokes the response callback only after a status line has been parsed,
        // so `res.statusCode` is always defined here.
        const statusCode = res.statusCode as number;
        resolve({
          statusCode,
          headers: normalizeHeaders(res.headers),
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      });
      clientRequest.on('error', (err) => {
        reject(networkError(sanitizeErrorReason(err as NodeJS.ErrnoException)));
      });
      if (req.body !== undefined) {
        clientRequest.write(Buffer.from(req.body));
      }
      clientRequest.end();
    });
  };
}

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NodeHttpTransport,
  normalizeHeaders,
  sanitizeErrorReason,
} from '../../../../src/adapters/node/node-http-transport.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { httpTransportContractTests, type MockSetup } from '../../ports/http-transport.contract.js';

type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

describe('NodeHttpTransport', () => {
  let server: http.Server;
  let port: number;
  const handlers = new Map<string, MockHandler>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const key = `${req.method ?? 'GET'} ${pathname}`;
      const handler = handlers.get(key);
      if (handler !== undefined) {
        handler(req, res);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  httpTransportContractTests(async () => {
    // The contract tests a mixed matrix: some tests expect a working HTTP round-trip
    // (requires allowInsecureHttp=true for local server), while the "secure adapter rejects
    // http://" test expects a secure adapter. We route requests: local mock server uses the
    // insecure transport; all other URLs use a secure (default) transport that rejects http://.
    const insecureSut = new NodeHttpTransport({ allowInsecureHttp: true });
    const secureSut = new NodeHttpTransport();
    const sut = {
      request: async (
        req: Parameters<NodeHttpTransport['request']>[0],
      ): ReturnType<NodeHttpTransport['request']> => {
        if (req.url.startsWith(`http://localhost:${port}`)) {
          return insecureSut.request(req);
        }
        return secureSut.request(req);
      },
    };
    return {
      sut,
      setupMock: (mock: MockSetup): string => {
        const url = new URL(mock.url);
        const key = `${mock.method} ${url.pathname}`;
        handlers.set(key, (_req, res) => {
          res.statusCode = mock.response.statusCode;
          for (const [headerKey, headerValue] of Object.entries(mock.response.headers)) {
            res.setHeader(headerKey, headerValue);
          }
          res.end(Buffer.from(mock.response.body));
        });
        return `http://localhost:${port}${url.pathname}`;
      },
      clearMocks: (): void => {
        handlers.clear();
      },
    };
  });

  describe('node-specific behaviors', () => {
    describe('Given http:// URL with allowInsecureHttp=false', () => {
      describe('When requesting', () => {
        it('Then throws NETWORK_ERROR', async () => {
          // Arrange
          const sut = new NodeHttpTransport();

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url: `http://localhost:${port}/anything`,
              method: 'GET',
              headers: {},
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NETWORK_ERROR');
        });
      });
    });

    describe('Given unreachable host', () => {
      describe('When requesting', () => {
        it('Then NETWORK_ERROR reason is sanitized (no host/port leak)', async () => {
          // Arrange — port 1 is ~always closed on localhost, guaranteed ECONNREFUSED without DNS
          const sut = new NodeHttpTransport({ allowInsecureHttp: true });

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url: 'http://127.0.0.1:1/will-refuse',
              method: 'GET',
              headers: {},
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('NETWORK_ERROR');
          if (data.code === 'NETWORK_ERROR') {
            // Sanitized: must not include path/port details from the URL
            expect(data.reason).not.toContain('127.0.0.1');
            expect(data.reason).not.toContain('1');
          }
        });
      });
    });

    describe('Given POST with body', () => {
      describe('When requesting', () => {
        it('Then server receives the body', async () => {
          // Arrange
          const sut = new NodeHttpTransport({ allowInsecureHttp: true });
          const received: Buffer[] = [];
          handlers.set('POST /echo', (req, res) => {
            req.on('data', (chunk: Buffer) => received.push(chunk));
            req.on('end', () => {
              res.statusCode = 204;
              res.end();
            });
          });
          const body = new Uint8Array([1, 2, 3, 4, 5]);

          // Act
          const response = await sut.request({
            url: `http://localhost:${port}/echo`,
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          });
          // Drain response to ensure completion
          const reader = response.body.getReader();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }

          // Assert
          expect(response.statusCode).toBe(204);
          expect(Buffer.concat(received)).toEqual(Buffer.from(body));
          handlers.clear();
        });
      });
    });

    describe('Given request with custom headers', () => {
      describe('When requesting', () => {
        it('Then the server receives those exact headers', async () => {
          // Arrange — proves headers from the request are forwarded. Kills the ObjectLiteral → {}
          // mutant on the spread of req.headers into node's RequestOptions.
          const sut = new NodeHttpTransport({ allowInsecureHttp: true });
          let received: http.IncomingHttpHeaders | undefined;
          handlers.set('GET /headers-in', (req, res) => {
            received = req.headers;
            res.statusCode = 204;
            res.end();
          });

          // Act
          const response = await sut.request({
            url: `http://localhost:${port}/headers-in`,
            method: 'GET',
            headers: { 'x-tsgit-custom': 'sentinel-value', authorization: 'Bearer abc123' },
          });
          const reader = response.body.getReader();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }

          // Assert
          expect(received).toBeDefined();
          expect(received?.['x-tsgit-custom']).toBe('sentinel-value');
          expect(received?.authorization).toBe('Bearer abc123');
          handlers.clear();
        });
      });
    });

    describe('Given response with multi-value header', () => {
      describe('When reading', () => {
        it('Then array values joined with comma', async () => {
          // Arrange
          const sut = new NodeHttpTransport({ allowInsecureHttp: true });
          handlers.set('GET /multi', (_req, res) => {
            res.setHeader('set-cookie', ['a=1', 'b=2']);
            res.statusCode = 200;
            res.end();
          });

          // Act
          const response = await sut.request({
            url: `http://localhost:${port}/multi`,
            method: 'GET',
            headers: {},
          });
          const reader = response.body.getReader();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }

          // Assert
          expect(response.headers['set-cookie']).toContain('a=1');
          expect(response.headers['set-cookie']).toContain('b=2');
          handlers.clear();
        });
      });
    });

    describe('Given unresolvable DNS name', () => {
      describe('When requesting', () => {
        it('Then NETWORK_ERROR reason is "DNS resolution failed"', async () => {
          // Arrange — RFC 2606 reserves .invalid for guaranteed DNS failures
          const sut = new NodeHttpTransport();

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url: 'https://nonexistent-host-tsgit.invalid/path',
              method: 'GET',
              headers: {},
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('NETWORK_ERROR');
          if (data.code === 'NETWORK_ERROR') {
            expect(data.reason).toBe('DNS resolution failed');
            expect(data.reason).not.toContain('nonexistent-host-tsgit.invalid');
          }
        }, 15000);
      });
    });

    describe('Given request aborted via AbortSignal', () => {
      describe('When requesting', () => {
        it('Then NETWORK_ERROR falls through default sanitizer branch', async () => {
          // Arrange — pre-aborted signal hits the error handler immediately with a non-mapped code.
          const sut = new NodeHttpTransport({ allowInsecureHttp: true });
          handlers.set('GET /slow', (_req, res) => {
            // Never respond quickly — we expect abort before this returns.
            setTimeout(() => {
              res.statusCode = 200;
              res.end();
            }, 5000);
          });
          const controller = new AbortController();
          controller.abort();

          // Act
          let caught: unknown;
          try {
            await sut.request({
              url: `http://localhost:${port}/slow`,
              method: 'GET',
              headers: {},
              signal: controller.signal,
            });
          } catch (err) {
            caught = err;
          }
          handlers.clear();

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NETWORK_ERROR');
        });
      });
    });

    describe('normalizeHeaders — pure header-coercion helper', () => {
      describe('Given a raw header record', () => {
        describe('When normalizing', () => {
          it.each([
            {
              input: { 'Content-Type': 'text/plain' },
              expected: { 'content-type': 'text/plain' },
              label: 'a string value is lowercased and the value preserved',
            },
            {
              input: { 'Set-Cookie': ['a=1', 'b=2'] },
              expected: { 'set-cookie': 'a=1, b=2' },
              label: 'an array value is joined with comma space',
            },
            {
              input: { 'x-skip': undefined, 'x-keep': 'yes' },
              expected: { 'x-keep': 'yes' },
              omittedKey: 'x-skip',
              label: 'an undefined value entry is omitted',
            },
          ])('Then $label', ({ input, expected, omittedKey }) => {
            // Arrange / Act
            const sut = normalizeHeaders(input);

            // Assert
            expect(sut).toEqual(expected);
            if (omittedKey !== undefined) {
              expect(sut[omittedKey]).toBeUndefined();
            }
          });
        });
      });
    });

    describe('sanitizeErrorReason — pure helper covering every errno branch', () => {
      const makeErrnoError = (code: string | undefined): NodeJS.ErrnoException => {
        const err = new Error(code ?? 'no code') as NodeJS.ErrnoException;
        if (code !== undefined) err.code = code;
        return err;
      };

      describe('Given an errno on the underlying error', () => {
        describe('When sanitizing', () => {
          it.each([
            {
              code: 'ENOTFOUND',
              expected: 'DNS resolution failed',
              label: 'ENOTFOUND returns "DNS resolution failed"',
            },
            {
              code: 'ECONNREFUSED',
              expected: 'Connection refused',
              label: 'ECONNREFUSED returns "Connection refused"',
            },
            {
              code: 'ETIMEDOUT',
              expected: 'Connection timed out',
              label: 'ETIMEDOUT returns "Connection timed out"',
            },
            {
              code: 'ESOMETHINGELSE',
              expected: 'network error',
              forbidden: 'ESOMETHINGELSE',
              label: 'an unknown errno code returns static "network error" (no errno leak)',
            },
            {
              code: undefined,
              expected: 'network error',
              label: 'no code returns the fallback "network error"',
            },
          ])('Then $label', ({ code, expected, forbidden }) => {
            // Arrange
            const sut = makeErrnoError(code);

            // Act
            const reason = sanitizeErrorReason(sut);

            // Assert
            expect(reason).toBe(expected);
            if (forbidden !== undefined) {
              expect(reason).not.toContain(forbidden);
            }
          });
        });
      });
    });
  });
});

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
    it('Given http:// URL with allowInsecureHttp=false, When requesting, Then throws NETWORK_ERROR', async () => {
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

    it('Given unreachable host, When requesting, Then NETWORK_ERROR reason is sanitized (no host/port leak)', async () => {
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

    it('Given POST with body, When requesting, Then server receives the body', async () => {
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

    it('Given request with custom headers, When requesting, Then the server receives those exact headers', async () => {
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

    it('Given response with multi-value header, When reading, Then array values joined with comma', async () => {
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

    it('Given unresolvable DNS name, When requesting, Then NETWORK_ERROR reason is "DNS resolution failed"', async () => {
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

    it('Given request aborted via AbortSignal, When requesting, Then NETWORK_ERROR falls through default sanitizer branch', async () => {
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

    describe('normalizeHeaders — pure header-coercion helper', () => {
      it('Given string value, When normalizing, Then key is lowercased and value preserved', () => {
        // Arrange
        const sut = normalizeHeaders({ 'Content-Type': 'text/plain' });

        // Assert
        expect(sut).toEqual({ 'content-type': 'text/plain' });
      });

      it('Given array value, When normalizing, Then values are joined with comma space', () => {
        // Arrange
        const sut = normalizeHeaders({ 'Set-Cookie': ['a=1', 'b=2'] });

        // Assert
        expect(sut).toEqual({ 'set-cookie': 'a=1, b=2' });
      });

      it('Given undefined value, When normalizing, Then the entry is omitted', () => {
        // Arrange
        const sut = normalizeHeaders({ 'x-skip': undefined, 'x-keep': 'yes' });

        // Assert
        expect(sut).toEqual({ 'x-keep': 'yes' });
        expect(sut['x-skip']).toBeUndefined();
      });
    });

    describe('sanitizeErrorReason — pure helper covering every errno branch', () => {
      const makeErrnoError = (code: string | undefined): NodeJS.ErrnoException => {
        const err = new Error(code ?? 'no code') as NodeJS.ErrnoException;
        if (code !== undefined) err.code = code;
        return err;
      };

      it('Given ENOTFOUND errno, When sanitizing, Then returns "DNS resolution failed"', () => {
        // Arrange
        const sut = makeErrnoError('ENOTFOUND');

        // Act
        const reason = sanitizeErrorReason(sut);

        // Assert
        expect(reason).toBe('DNS resolution failed');
      });

      it('Given ECONNREFUSED errno, When sanitizing, Then returns "Connection refused"', () => {
        // Arrange
        const sut = makeErrnoError('ECONNREFUSED');

        // Act
        const reason = sanitizeErrorReason(sut);

        // Assert
        expect(reason).toBe('Connection refused');
      });

      it('Given ETIMEDOUT errno, When sanitizing, Then returns "Connection timed out"', () => {
        // Arrange
        const sut = makeErrnoError('ETIMEDOUT');

        // Act
        const reason = sanitizeErrorReason(sut);

        // Assert
        expect(reason).toBe('Connection timed out');
      });

      it('Given unknown errno code, When sanitizing, Then returns static "network error" (no errno leak)', () => {
        // Arrange — unknown codes like EPROTO / ECONNRESET must not leak into the message.
        const sut = makeErrnoError('ESOMETHINGELSE');

        // Act
        const reason = sanitizeErrorReason(sut);

        // Assert
        expect(reason).toBe('network error');
        expect(reason).not.toContain('ESOMETHINGELSE');
      });

      it('Given error with no code, When sanitizing, Then returns fallback "network error"', () => {
        // Arrange
        const sut = makeErrnoError(undefined);

        // Act
        const reason = sanitizeErrorReason(sut);

        // Assert
        expect(reason).toBe('network error');
      });
    });
  });
});

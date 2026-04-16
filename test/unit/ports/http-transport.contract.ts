import { beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/index.js';
import type { HttpTransport } from '../../../src/ports/http-transport.js';

export interface MockSetup {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly response: {
    readonly statusCode: number;
    readonly headers: Record<string, string>;
    readonly body: Uint8Array;
  };
}

export interface HttpTransportContractEnv {
  readonly sut: HttpTransport;
  /** Register a mock response; returns the concrete URL to use in the request (may differ from mock.url, e.g., adapter injects dynamic port). */
  readonly setupMock: (mock: MockSetup) => string;
  /** Clear all registered mocks for per-test isolation. */
  readonly clearMocks: () => void;
}

export function httpTransportContractTests(
  createSut: () => Promise<HttpTransportContractEnv>,
): void {
  describe('HttpTransport contract', () => {
    let env: HttpTransportContractEnv;

    beforeEach(async () => {
      env = await createSut();
      env.clearMocks();
    });

    it('Given mock response, When requesting, Then returns correct statusCode', async () => {
      const url = env.setupMock({
        method: 'GET',
        url: 'https://example.com/test',
        response: { statusCode: 200, headers: {}, body: new Uint8Array() },
      });
      const res = await env.sut.request({ url, method: 'GET', headers: {} });
      expect(res.statusCode).toBe(200);
    });

    it('Given response with mixed-case headers, When reading, Then all keys are lowercase', async () => {
      const url = env.setupMock({
        method: 'GET',
        url: 'https://example.com/headers',
        response: {
          statusCode: 200,
          headers: { 'Content-Type': 'text/plain', 'X-Foo': 'bar' },
          body: new Uint8Array(),
        },
      });
      const res = await env.sut.request({ url, method: 'GET', headers: {} });
      // All header keys must be lowercased by the adapter
      for (const key of Object.keys(res.headers)) {
        expect(key).toBe(key.toLowerCase());
      }
      // Original mixed-case should be accessible via lowercase
      expect(res.headers['content-type']).toBeDefined();
    });

    it('Given HTTP (non-HTTPS) URL with secure adapter, When requesting, Then throws NETWORK_ERROR', async () => {
      try {
        await env.sut.request({
          url: 'http://example.com/insecure',
          method: 'GET',
          headers: {},
        });
        expect.fail('expected NETWORK_ERROR');
      } catch (err) {
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('NETWORK_ERROR');
      }
    });
  });
}

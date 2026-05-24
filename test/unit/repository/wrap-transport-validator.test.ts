import { describe, expect, it, vi } from 'vitest';

import { TsgitError } from '../../../src/domain/error.js';
import type { HttpResponse, HttpTransport } from '../../../src/ports/http-transport.js';
import { wrapTransportValidator } from '../../../src/repository/wrap-transport-validator.js';

const fakeResponse = (): HttpResponse =>
  ({ statusCode: 200, headers: {}, body: undefined as unknown }) as unknown as HttpResponse;

const stubTransport = (): HttpTransport =>
  ({ request: vi.fn(async () => fakeResponse()) }) as unknown as HttpTransport;

const expectBlocked = async (
  fn: () => Promise<unknown>,
  expectedCodes: ReadonlyArray<string> = ['BLOCKED_HOST', 'UNSUPPORTED_SCHEME', 'INVALID_URL'],
): Promise<void> => {
  try {
    await fn();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    expect(expectedCodes).toContain((err as TsgitError).data.code);
  }
};

describe('wrapTransportValidator — happy path', () => {
  describe('Given a public https URL and a resolver returning a public IP', () => {
    describe('When request runs', () => {
      it('Then transport.request is called', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['1.1.1.1'],
        });

        await sut.request({ url: 'https://example.com/info/refs', method: 'GET', headers: {} });

        // Assert
        expect(transport.request).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('wrapTransportValidator — SSRF guards', () => {
  describe('Given config undefined and any URL', () => {
    describe('When request runs', () => {
      it('Then validation rejects (fail-closed default resolver)', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, undefined);

        // Assert
        await expectBlocked(() =>
          sut.request({ url: 'https://example.com/x', method: 'GET', headers: {} }),
        );
        expect(transport.request).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a resolver that returns a private IP and allowPrivateNetworks=false', () => {
    describe('When request runs', () => {
      it('Then it throws BLOCKED_HOST', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['10.0.0.1'],
          allowPrivateNetworks: false,
        });

        // Assert
        await expectBlocked(
          () => sut.request({ url: 'https://example.com/x', method: 'GET', headers: {} }),
          ['BLOCKED_HOST'],
        );
      });
    });
  });

  describe('Given a resolver that returns a private IP and allowPrivateNetworks=true', () => {
    describe('When request runs', () => {
      it('Then transport.request is called', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['10.0.0.1'],
          allowPrivateNetworks: true,
        });

        await sut.request({ url: 'https://example.com/x', method: 'GET', headers: {} });
        // Assert
        expect(transport.request).toHaveBeenCalled();
      });
    });
  });

  describe('Given config without allowPrivateNetworks set (default)', () => {
    describe('When the resolver returns a private IP', () => {
      it('Then it throws BLOCKED_HOST (default is false — kills BooleanLiteral mutants on the ?? default)', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['192.168.1.1'],
        });

        // Assert
        await expectBlocked(
          () => sut.request({ url: 'https://example.com/x', method: 'GET', headers: {} }),
          ['BLOCKED_HOST'],
        );
      });
    });
  });

  describe('Given config without allowInsecure set (default)', () => {
    describe('When the URL is http://', () => {
      it('Then it throws UNSUPPORTED_SCHEME (default is false — kills BooleanLiteral mutants)', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['1.1.1.1'],
        });

        // Assert
        await expectBlocked(
          () => sut.request({ url: 'http://example.com/x', method: 'GET', headers: {} }),
          ['UNSUPPORTED_SCHEME'],
        );
      });
    });
  });

  describe('Given an http:// URL with allowInsecure=false', () => {
    describe('When request runs', () => {
      it('Then it throws UNSUPPORTED_SCHEME', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['1.1.1.1'],
          allowInsecure: false,
        });

        // Assert
        await expectBlocked(
          () => sut.request({ url: 'http://example.com/x', method: 'GET', headers: {} }),
          ['UNSUPPORTED_SCHEME'],
        );
      });
    });
  });

  describe('Given an http:// URL with allowInsecure=true', () => {
    describe('When request runs', () => {
      it('Then transport.request is called', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['1.1.1.1'],
          allowInsecure: true,
        });

        await sut.request({ url: 'http://example.com/x', method: 'GET', headers: {} });
        // Assert
        expect(transport.request).toHaveBeenCalled();
      });
    });
  });

  describe('Given a malformed URL', () => {
    describe('When request runs', () => {
      it('Then it throws INVALID_URL or UNSUPPORTED_SCHEME', async () => {
        // Arrange
        const transport = stubTransport();
        const sut = wrapTransportValidator(transport, {
          dnsResolver: async () => ['1.1.1.1'],
        });

        // Assert
        await expectBlocked(() => sut.request({ url: 'not-a-url', method: 'GET', headers: {} }));
      });
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { HttpRequest } from '../../../src/ports/http-transport.js';
import { withAuth } from '../../../src/transport/with-auth.js';
import { fakeTransport, makeRequest, makeResponse } from './fixtures.js';

describe('withAuth — validation', () => {
  describe('Given bearer with empty token', () => {
    describe('When created', () => {
      it('Then throws TypeError "withAuth: token is empty"', () => {
        // Arrange
        try {
          withAuth({ type: 'bearer', token: '' });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TypeError);
          expect((err as TypeError).message).toBe('withAuth: token is empty');
        }
      });
    });
  });

  describe('Given basic with username=%j containing ":"', () => {
    describe('When created', () => {
      it.each(['a:b', 'a:', ':a'])('Then throws TypeError', (username) => {
        // Arrange
        try {
          withAuth({ type: 'basic', username, password: 'x' });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TypeError);
          expect((err as TypeError).message).toBe('withAuth: basic username must not contain ":"');
        }
      });
    });
  });

  describe('Given basic with empty username', () => {
    describe('When created', () => {
      it('Then returns a factory', () => {
        // Arrange
        const sut = typeof withAuth({ type: 'basic', username: '', password: 'x' });

        // Assert
        expect(sut).toBe('function');
      });
    });
  });

  describe('Given basic with empty password', () => {
    describe('When created', () => {
      it('Then returns a factory', () => {
        // Arrange
        const sut = typeof withAuth({ type: 'basic', username: 'u', password: '' });

        // Assert
        expect(sut).toBe('function');
      });
    });
  });

  describe('Given custom config', () => {
    describe('When created', () => {
      it('Then returns a factory', () => {
        // Arrange
        const sut = typeof withAuth({ type: 'custom', header: () => 'token' });

        // Assert
        expect(sut).toBe('function');
      });
    });
  });
});

describe('withAuth — bearer', () => {
  describe('Given a request with no Authorization header', () => {
    describe('When sent', () => {
      it('Then inner sees authorization=Bearer xyz', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'bearer', token: 'xyz' })(transport);
        await sut.request(makeRequest());
        // Assert
        expect(calls[0]?.headers.authorization).toBe('Bearer xyz');
      });
    });
  });

  describe('Given a request with non-auth headers', () => {
    describe('When sent', () => {
      it('Then auth header is added (mutant kill: hasAuthHeader must scan for "authorization" specifically)', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'bearer', token: 'tok' })(transport);
        await sut.request(makeRequest({ headers: { 'x-trace-id': 'abc' } }));
        // Assert
        expect(calls[0]?.headers.authorization).toBe('Bearer tok');
        expect(calls[0]?.headers['x-trace-id']).toBe('abc');
      });
    });
  });

  describe('Given an existing Authorization header (capital A)', () => {
    describe('When sent', () => {
      it('Then existing key wins; no duplicate added', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'bearer', token: 'xyz' })(transport);
        await sut.request(makeRequest({ headers: { Authorization: 'Bearer override' } }));
        const inner = calls[0]?.headers ?? {};
        // Assert
        expect(inner.Authorization).toBe('Bearer override');
        expect(inner.authorization).toBeUndefined();
      });
    });
  });

  describe('Given an existing authorization header (lowercase)', () => {
    describe('When sent', () => {
      it('Then lowercase key wins; no duplicate added', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'bearer', token: 'xyz' })(transport);
        await sut.request(makeRequest({ headers: { authorization: 'Bearer override' } }));
        const inner = calls[0]?.headers ?? {};
        // Assert
        expect(inner.authorization).toBe('Bearer override');
        expect(inner.Authorization).toBeUndefined();
      });
    });
  });
});

describe('withAuth — basic (UTF-8)', () => {
  describe('Given username/password ASCII', () => {
    describe('When sent', () => {
      it('Then header equals base64(username:password)', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'basic', username: 'alice', password: 'wonderland' })(
          transport,
        );
        await sut.request(makeRequest());
        // Assert
        expect(calls[0]?.headers.authorization).toBe('Basic YWxpY2U6d29uZGVybGFuZA==');
      });
    });
  });

  describe('Given non-ASCII credentials', () => {
    describe('When sent', () => {
      it('Then header equals "Basic " + base64(utf8 bytes)', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'basic', username: 'münchen', password: 'paßwort' })(
          transport,
        );
        await sut.request(makeRequest());
        const expected = `Basic ${Buffer.from('münchen:paßwort', 'utf8').toString('base64')}`;
        // Assert
        expect(calls[0]?.headers.authorization).toBe(expected);
      });
    });
  });

  describe('Given empty username', () => {
    describe('When sent', () => {
      it('Then header equals base64(":secret")', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'basic', username: '', password: 'secret' })(transport);
        await sut.request(makeRequest());
        const expected = `Basic ${Buffer.from(':secret', 'utf8').toString('base64')}`;
        // Assert
        expect(calls[0]?.headers.authorization).toBe(expected);
      });
    });
  });

  describe('Given empty password', () => {
    describe('When sent', () => {
      it('Then header equals base64("user:")', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'basic', username: 'user', password: '' })(transport);
        await sut.request(makeRequest());
        const expected = `Basic ${Buffer.from('user:', 'utf8').toString('base64')}`;
        // Assert
        expect(calls[0]?.headers.authorization).toBe(expected);
      });
    });
  });
});

describe('withAuth — custom', () => {
  describe('Given a callback returning a string', () => {
    describe('When sent', () => {
      it('Then inner sees authorization=that-string', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'custom', header: () => 'CustomScheme abc' })(transport);
        await sut.request(makeRequest());
        // Assert
        expect(calls[0]?.headers.authorization).toBe('CustomScheme abc');
      });
    });
  });

  describe('Given a callback returning a Promise<string>', () => {
    describe('When sent', () => {
      it('Then inner sees the resolved value', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({
          type: 'custom',
          header: async () => 'token',
        })(transport);
        await sut.request(makeRequest());
        // Assert
        expect(calls[0]?.headers.authorization).toBe('token');
      });
    });
  });

  describe('Given a callback receiving the request', () => {
    describe('When invoked', () => {
      it('Then it sees the original request fields', async () => {
        // Arrange
        const { transport } = fakeTransport([makeResponse()]);
        let received: { url: string; method: string } | undefined;
        const sut = withAuth({
          type: 'custom',
          header: (r: HttpRequest) => {
            received = { url: r.url, method: r.method };
            return 'tok';
          },
        })(transport);
        const req = makeRequest({ url: 'https://example.com/x', method: 'POST' });
        await sut.request(req);
        // Assert
        expect(received?.url).toBe(req.url);
        expect(received?.method).toBe(req.method);
      });
    });
  });

  describe('Given a callback returning %j', () => {
    describe('When sent', () => {
      it.each([
        ['' as string],
        [undefined as unknown as string],
        [null as unknown as string],
      ])('Then rejects with TypeError "withAuth: custom returned empty value" and inner is NOT called', async (value) => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const sut = withAuth({ type: 'custom', header: () => value })(transport);
        try {
          await sut.request(makeRequest());
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TypeError);
          expect((err as TypeError).message).toBe('withAuth: custom returned empty value');
        }
        expect(calls).toHaveLength(0);
      });
    });
  });

  describe('Given a request with existing Authorization header AND a custom callback', () => {
    describe('When sent', () => {
      it('Then callback is NOT invoked and existing header is forwarded unchanged', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const cb = vi.fn<(r: HttpRequest) => string>().mockReturnValue('should-not-be-used');
        const sut = withAuth({ type: 'custom', header: cb })(transport);
        await sut.request(makeRequest({ headers: { authorization: 'Bearer pre-existing' } }));
        // Assert
        expect(cb).not.toHaveBeenCalled();
        expect(calls[0]?.headers.authorization).toBe('Bearer pre-existing');
      });
    });
  });

  describe('Given a callback that throws', () => {
    describe('When sent', () => {
      it('Then rejects with the original error and inner is NOT called', async () => {
        // Arrange
        const { transport, calls } = fakeTransport([makeResponse()]);
        const boom = new Error('boom');
        const sut = withAuth({
          type: 'custom',
          header: () => {
            throw boom;
          },
        })(transport);
        // Assert
        await expect(sut.request(makeRequest())).rejects.toBe(boom);
        expect(calls).toHaveLength(0);
      });
    });
  });
});

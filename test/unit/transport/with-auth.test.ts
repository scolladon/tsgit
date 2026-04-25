import { describe, expect, it, vi } from 'vitest';

import type { HttpRequest } from '../../../src/ports/http-transport.js';
import { withAuth } from '../../../src/transport/with-auth.js';
import { fakeTransport, makeRequest, makeResponse } from './fixtures.js';

describe('withAuth — validation', () => {
  it('Given bearer with empty token, When created, Then throws TypeError "withAuth: token is empty"', () => {
    try {
      withAuth({ type: 'bearer', token: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect((err as TypeError).message).toBe('withAuth: token is empty');
    }
  });

  it.each([
    'a:b',
    'a:',
    ':a',
  ])('Given basic with username=%j containing ":", When created, Then throws TypeError', (username) => {
    try {
      withAuth({ type: 'basic', username, password: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect((err as TypeError).message).toBe('withAuth: basic username must not contain ":"');
    }
  });

  it('Given basic with empty username, When created, Then returns a factory', () => {
    expect(typeof withAuth({ type: 'basic', username: '', password: 'x' })).toBe('function');
  });

  it('Given basic with empty password, When created, Then returns a factory', () => {
    expect(typeof withAuth({ type: 'basic', username: 'u', password: '' })).toBe('function');
  });

  it('Given custom config, When created, Then returns a factory', () => {
    expect(typeof withAuth({ type: 'custom', header: () => 'token' })).toBe('function');
  });
});

describe('withAuth — bearer', () => {
  it('Given a request with no Authorization header, When sent, Then inner sees authorization=Bearer xyz', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'bearer', token: 'xyz' })(transport);
    await sut.request(makeRequest());
    expect(calls[0]?.headers.authorization).toBe('Bearer xyz');
  });

  it('Given a request with non-auth headers, When sent, Then auth header is added (mutant kill: hasAuthHeader must scan for "authorization" specifically)', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'bearer', token: 'tok' })(transport);
    await sut.request(makeRequest({ headers: { 'x-trace-id': 'abc' } }));
    expect(calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(calls[0]?.headers['x-trace-id']).toBe('abc');
  });

  it('Given an existing Authorization header (capital A), When sent, Then existing key wins; no duplicate added', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'bearer', token: 'xyz' })(transport);
    await sut.request(makeRequest({ headers: { Authorization: 'Bearer override' } }));
    const inner = calls[0]?.headers ?? {};
    expect(inner.Authorization).toBe('Bearer override');
    expect(inner.authorization).toBeUndefined();
  });

  it('Given an existing authorization header (lowercase), When sent, Then lowercase key wins; no duplicate added', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'bearer', token: 'xyz' })(transport);
    await sut.request(makeRequest({ headers: { authorization: 'Bearer override' } }));
    const inner = calls[0]?.headers ?? {};
    expect(inner.authorization).toBe('Bearer override');
    expect(inner.Authorization).toBeUndefined();
  });
});

describe('withAuth — basic (UTF-8)', () => {
  it('Given username/password ASCII, When sent, Then header equals base64(username:password)', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'basic', username: 'alice', password: 'wonderland' })(transport);
    await sut.request(makeRequest());
    expect(calls[0]?.headers.authorization).toBe('Basic YWxpY2U6d29uZGVybGFuZA==');
  });

  it('Given non-ASCII credentials, When sent, Then header equals "Basic " + base64(utf8 bytes)', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'basic', username: 'münchen', password: 'paßwort' })(transport);
    await sut.request(makeRequest());
    const expected = `Basic ${Buffer.from('münchen:paßwort', 'utf8').toString('base64')}`;
    expect(calls[0]?.headers.authorization).toBe(expected);
  });

  it('Given empty username, When sent, Then header equals base64(":secret")', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'basic', username: '', password: 'secret' })(transport);
    await sut.request(makeRequest());
    const expected = `Basic ${Buffer.from(':secret', 'utf8').toString('base64')}`;
    expect(calls[0]?.headers.authorization).toBe(expected);
  });

  it('Given empty password, When sent, Then header equals base64("user:")', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'basic', username: 'user', password: '' })(transport);
    await sut.request(makeRequest());
    const expected = `Basic ${Buffer.from('user:', 'utf8').toString('base64')}`;
    expect(calls[0]?.headers.authorization).toBe(expected);
  });
});

describe('withAuth — custom', () => {
  it('Given a callback returning a string, When sent, Then inner sees authorization=that-string', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'custom', header: () => 'CustomScheme abc' })(transport);
    await sut.request(makeRequest());
    expect(calls[0]?.headers.authorization).toBe('CustomScheme abc');
  });

  it('Given a callback returning a Promise<string>, When sent, Then inner sees the resolved value', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({
      type: 'custom',
      header: async () => 'token',
    })(transport);
    await sut.request(makeRequest());
    expect(calls[0]?.headers.authorization).toBe('token');
  });

  it('Given a callback receiving the request, When invoked, Then it sees the original request fields', async () => {
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
    expect(received?.url).toBe(req.url);
    expect(received?.method).toBe(req.method);
  });

  it.each([
    ['' as string],
    [undefined as unknown as string],
    [null as unknown as string],
  ])('Given a callback returning %j, When sent, Then rejects with TypeError "withAuth: custom returned empty value" and inner is NOT called', async (value) => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const sut = withAuth({ type: 'custom', header: () => value })(transport);
    try {
      await sut.request(makeRequest());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect((err as TypeError).message).toBe('withAuth: custom returned empty value');
    }
    expect(calls).toHaveLength(0);
  });

  it('Given a request with existing Authorization header AND a custom callback, When sent, Then callback is NOT invoked and existing header is forwarded unchanged', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const cb = vi.fn<(r: HttpRequest) => string>().mockReturnValue('should-not-be-used');
    const sut = withAuth({ type: 'custom', header: cb })(transport);
    await sut.request(makeRequest({ headers: { authorization: 'Bearer pre-existing' } }));
    expect(cb).not.toHaveBeenCalled();
    expect(calls[0]?.headers.authorization).toBe('Bearer pre-existing');
  });

  it('Given a callback that throws, When sent, Then rejects with the original error and inner is NOT called', async () => {
    const { transport, calls } = fakeTransport([makeResponse()]);
    const boom = new Error('boom');
    const sut = withAuth({
      type: 'custom',
      header: () => {
        throw boom;
      },
    })(transport);
    await expect(sut.request(makeRequest())).rejects.toBe(boom);
    expect(calls).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { LogEvent, Logger } from '../../../src/transport/types.js';
import { withLogging } from '../../../src/transport/with-logging.js';
import {
  fakeClock,
  fakeTransport,
  makeRequest,
  makeResponse,
  recordingLogger,
} from './fixtures.js';

describe('withLogging — events on success', () => {
  it('Given inner resolves with statusCode 200, When request is awaited, Then events contain request then response', async () => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse({ statusCode: 200 })]);
    const sut = withLogging({ logger })(transport);
    await sut.request(makeRequest());
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('request');
    expect(events[1]?.kind).toBe('response');
    if (events[1]?.kind === 'response') {
      expect(events[1].statusCode).toBe(200);
      expect(events[1].elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('Given a fakeClock that advances 250ms, When request is awaited, Then response.elapsedMs equals 250', async () => {
    const { logger, events } = recordingLogger();
    const clock = fakeClock(1000);
    const { transport } = fakeTransport([makeResponse({ statusCode: 200 })]);
    const wrapped = withLogging({ logger, now: clock.now })(transport);

    const innerCallSpy = transport.request as unknown as { mockImplementationOnce?: unknown };
    void innerCallSpy;

    const promise = wrapped.request(makeRequest());
    clock.advance(250);
    await promise;
    if (events[1]?.kind === 'response') {
      expect(events[1].elapsedMs).toBe(250);
    } else {
      throw new Error('expected response event');
    }
  });
});

describe('withLogging — events on failure', () => {
  it('Given inner rejects, When awaited, Then events are [request, error] and error reference unchanged', async () => {
    const { logger, events } = recordingLogger();
    const original = new Error('boom');
    const { transport } = fakeTransport([original]);
    const sut = withLogging({ logger })(transport);
    await expect(sut.request(makeRequest())).rejects.toBe(original);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('request');
    expect(events[1]?.kind).toBe('error');
    if (events[1]?.kind === 'error') {
      expect(events[1].errorMessage).toBe('boom');
    }
  });

  it('Given a fakeClock that advances 700ms before inner rejects, When awaited, Then error.elapsedMs equals 700', async () => {
    const { logger, events } = recordingLogger();
    const clock = fakeClock(500);
    const transport = {
      request: async () => {
        clock.advance(700);
        throw new Error('slow boom');
      },
    };
    const sut = withLogging({ logger, now: clock.now })(transport);
    await expect(sut.request(makeRequest())).rejects.toThrow('slow boom');
    if (events[1]?.kind !== 'error') throw new Error('expected error event');
    expect(events[1].elapsedMs).toBe(700);
  });
});

describe('withLogging — header redaction', () => {
  it('Given authorization (lowercase), When sent, Then events.headers.authorization is undefined', async () => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger })(transport);
    await sut.request(
      makeRequest({ headers: { authorization: 'Bearer xyz', 'x-trace-id': 'abc' } }),
    );
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    expect(events[0].headers.authorization).toBeUndefined();
    expect(events[0].headers['x-trace-id']).toBe('abc');
  });

  it('Given Authorization (capital), When sent, Then NO key whose lowercase form is "authorization" is present', async () => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger })(transport);
    await sut.request(makeRequest({ headers: { Authorization: 'Bearer xyz' } }));
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    const keys = Object.keys(events[0].headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('authorization');
  });

  it('Given redactHeaders=[], When authorization present, Then it is STILL stripped (forced; non-opt-out)', async () => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger, redactHeaders: [] })(transport);
    await sut.request(makeRequest({ headers: { authorization: 'Bearer xyz' } }));
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    expect(events[0].headers.authorization).toBeUndefined();
  });

  it('Given redactHeaders=["x-trace-id"], When sent, Then both authorization and x-trace-id are stripped', async () => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger, redactHeaders: ['x-trace-id'] })(transport);
    await sut.request(
      makeRequest({ headers: { authorization: 'Bearer xyz', 'x-trace-id': 'abc' } }),
    );
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    expect(events[0].headers.authorization).toBeUndefined();
    expect(events[0].headers['x-trace-id']).toBeUndefined();
  });

  it('Given a response with set-cookie + authorization, When logged, Then those headers are stripped from the response event', async () => {
    // Arrange
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([
      makeResponse({
        headers: { 'set-cookie': 'sid=abc', authorization: 'Bearer secret', 'x-id': 'ok' },
      }),
    ]);
    const sut = withLogging({ logger })(transport);

    // Act
    await sut.request(makeRequest());

    // Assert
    if (events[1]?.kind !== 'response') throw new Error('expected response event');
    const keys = Object.keys(events[1].headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('set-cookie');
    expect(events[1].headers['x-id']).toBe('ok');
  });

  it('Given a request with cookie, set-cookie, proxy-authorization, authorization headers, When sent, Then all four are stripped', async () => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger })(transport);
    await sut.request(
      makeRequest({
        headers: {
          authorization: 'a',
          cookie: 'b',
          'set-cookie': 'c',
          'proxy-authorization': 'd',
        },
      }),
    );
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    const keys = Object.keys(events[0].headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('cookie');
    expect(keys).not.toContain('set-cookie');
    expect(keys).not.toContain('proxy-authorization');
  });
});

describe('withLogging — URL redaction', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://example.com/r?access_token=xyz&page=2', 'https://example.com/r?page=2'],
    ['https://example.com/r?api_key=abc', 'https://example.com/r'],
    ['https://example.com/r?api-key=abc', 'https://example.com/r'],
    ['https://example.com/r?Token=foo', 'https://example.com/r'],
    ['https://example.com/r?normal=value', 'https://example.com/r?normal=value'],
    ['https://example.com/r?password=hunter2', 'https://example.com/r'],
    ['https://example.com/r?secret=foo&token=bar&page=2', 'https://example.com/r?page=2'],
  ];

  it.each(cases)('Given url=%j, When logged, Then events[0].url=%j', async (input, expected) => {
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger })(transport);
    await sut.request(makeRequest({ url: input }));
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    expect(events[0].url).toBe(expected);
  });

  it('Given a URL with a non-sensitive query key, When logged, Then that key is preserved (deletion list starts empty)', async () => {
    // Arrange — the to-delete list is seeded as `[]`; an `["..."]` mutant
    // would pre-seed a spurious key and delete it from the URL. Using that
    // exact literal as a query key proves the seed list is genuinely empty.
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger })(transport);

    // Act
    await sut.request(makeRequest({ url: 'https://example.com/r?Stryker+was+here=keep' }));

    // Assert
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    expect(events[0].url).toBe('https://example.com/r?Stryker+was+here=keep');
  });
});

describe('withLogging — extra header redaction defaulting', () => {
  it('Given no redactHeaders config, When a non-sensitive header is sent, Then it is preserved (extra-redact list defaults to empty)', async () => {
    // Arrange — `config.redactHeaders ?? []` defaults to `[]`. An `["..."]`
    // mutant would pre-seed a header name and strip it. Sending exactly that
    // header proves the default list is genuinely empty.
    const { logger, events } = recordingLogger();
    const { transport } = fakeTransport([makeResponse()]);
    const sut = withLogging({ logger })(transport);

    // Act
    await sut.request(makeRequest({ headers: { 'Stryker was here': 'kept' } }));

    // Assert
    if (events[0]?.kind !== 'request') throw new Error('expected request');
    expect(events[0].headers['Stryker was here']).toBe('kept');
  });
});

describe('withLogging — logger throw safety', () => {
  it('Given a logger that throws on every event, When request resolves with 200, Then wrapped resolves with 200 (throw swallowed)', async () => {
    const logger: Logger = {
      log: () => {
        throw new Error('boom');
      },
    };
    const { transport } = fakeTransport([makeResponse({ statusCode: 200 })]);
    const sut = withLogging({ logger })(transport);
    const result = await sut.request(makeRequest());
    expect(result.statusCode).toBe(200);
  });

  it('Given a logger that throws only on request event, When sent, Then response event still emitted and request resolves', async () => {
    const events: LogEvent[] = [];
    const logger: Logger = {
      log: (e) => {
        if (e.kind === 'request') throw new Error('boom');
        events.push(e);
      },
    };
    const { transport } = fakeTransport([makeResponse({ statusCode: 200 })]);
    const sut = withLogging({ logger })(transport);
    await sut.request(makeRequest());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('response');
  });
});

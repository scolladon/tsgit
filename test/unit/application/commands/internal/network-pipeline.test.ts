import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHttpTransport } from '../../../../../src/adapters/memory/memory-http-transport.js';
import {
  withDefaults,
  wrapLoggerSanitizer,
} from '../../../../../src/application/commands/internal/network-pipeline.js';
import type { LogEvent, Logger } from '../../../../../src/transport/index.js';

const collectLogs = (): { readonly logger: Logger; readonly events: ReadonlyArray<LogEvent> } => {
  const events: LogEvent[] = [];
  const logger: Logger = { log: (e) => events.push(e) };
  return { logger, events };
};

const setupMock = (
  transport: MemoryHttpTransport,
  url: string,
  headers: Record<string, string> = {},
): void => {
  transport.addMockResponse({
    method: 'GET',
    url,
    response: { statusCode: 200, headers, body: new Uint8Array() },
  });
};

const drainBody = async (body: ReadableStream<Uint8Array>): Promise<void> => {
  const reader = body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
};

describe('internal/network-pipeline', () => {
  describe('wrapLoggerSanitizer', () => {
    let inner: ReturnType<typeof collectLogs>;
    beforeEach(() => {
      inner = collectLogs();
    });

    describe('Given an event with CR (0x0D) in URL', () => {
      describe('When logged', () => {
        it('Then CR is escaped as \\x0D', () => {
          // Arrange
          const sut = wrapLoggerSanitizer(inner.logger);
          const event: LogEvent = {
            kind: 'request',
            method: 'GET',
            url: 'https://example.com/path\rinjected',
            headers: {},
            bodyBytes: 0,
          };

          // Act
          sut.log(event);

          // Assert
          const recorded = inner.events[0] as { url: string };
          expect(recorded.url).toBe('https://example.com/path\\x0Dinjected');
        });
      });
    });

    describe('Given an event with LF (0x0A) in URL', () => {
      describe('When logged', () => {
        it('Then LF is preserved verbatim', () => {
          // Arrange
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'request',
            method: 'GET',
            url: 'a\nb',
            headers: {},
            bodyBytes: 0,
          });

          // Assert
          const recorded = inner.events[0] as { url: string };
          expect(recorded.url).toBe('a\nb');
        });
      });
    });

    describe('Given an event with TAB (0x09)', () => {
      describe('When logged', () => {
        it('Then TAB is preserved', () => {
          // Arrange
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'request',
            method: 'GET',
            url: 'a\tb',
            headers: {},
            bodyBytes: 0,
          });

          // Assert
          const recorded = inner.events[0] as { url: string };
          expect(recorded.url).toBe('a\tb');
        });
      });
    });

    describe('Given an event with high bytes (0x80) in headers', () => {
      describe('When logged', () => {
        it('Then bytes are escaped', () => {
          // Arrange
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'response',
            statusCode: 200,
            url: 'https://example.com/',
            elapsedMs: 1,
            headers: { 'x-attacker': 'val\x80ue' },
          });

          // Assert
          const recorded = inner.events[0] as { headers: Record<string, string> };
          expect(recorded.headers['x-attacker']).toBe('val\\x80ue');
        });
      });
    });

    describe('Given a printable ASCII event', () => {
      describe('When logged', () => {
        it('Then it passes through unchanged', () => {
          // Arrange
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'request',
            method: 'GET',
            url: 'https://example.com/path',
            headers: { 'x-foo': 'bar' },
            bodyBytes: 42,
          });

          // Assert
          const recorded = inner.events[0] as { url: string; headers: Record<string, string> };
          expect(recorded.url).toBe('https://example.com/path');
          expect(recorded.headers['x-foo']).toBe('bar');
        });
      });
    });

    describe('Given an event with SPACE (0x20) in URL', () => {
      describe('When logged', () => {
        it('Then SPACE is preserved verbatim', () => {
          // Arrange — 0x20 is the lower bound of the printable range; the guard is
          // `code < 0x20`, so SPACE must pass through. A `<= 0x20` mutant would
          // escape it to \x20.
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'request',
            method: 'GET',
            url: 'a b',
            headers: {},
            bodyBytes: 0,
          });

          // Assert
          const recorded = inner.events[0] as { url: string };
          expect(recorded.url).toBe('a b');
        });
      });
    });

    describe('Given an event with TILDE (0x7E) in URL', () => {
      describe('When logged', () => {
        it('Then TILDE is preserved verbatim', () => {
          // Arrange — 0x7E is the upper bound of the printable range; the guard is
          // `code > 0x7e`, so TILDE must pass through. A `>= 0x7e` mutant would
          // escape it to \x7E.
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'request',
            method: 'GET',
            url: 'a~b',
            headers: {},
            bodyBytes: 0,
          });

          // Assert
          const recorded = inner.events[0] as { url: string };
          expect(recorded.url).toBe('a~b');
        });
      });
    });

    describe('Given an error event with control bytes in errorMessage', () => {
      describe('When logged', () => {
        it('Then bytes are escaped', () => {
          // Arrange
          const sut = wrapLoggerSanitizer(inner.logger);

          // Act
          sut.log({
            kind: 'error',
            url: 'https://example.com/',
            elapsedMs: 1,
            errorMessage: 'oops\rinjected',
          });

          // Assert
          const recorded = inner.events[0] as { errorMessage: string };
          expect(recorded.errorMessage).toBe('oops\\x0Dinjected');
        });
      });
    });
  });

  describe('withDefaults', () => {
    describe('Given ctx.config not frozen', () => {
      describe('When withDefaults is called', () => {
        it('Then ctx.config is left UNCHANGED (no side-effect mutation of caller-owned objects)', () => {
          // Arrange — the design moved freeze responsibility to's facade.
          // withDefaults must not mutate caller-owned objects.
          const ctx = createMemoryContext();
          const wasFrozen = Object.isFrozen(ctx.config);

          // Act
          withDefaults(ctx);

          // Assert
          expect(Object.isFrozen(ctx.config)).toBe(wasFrozen);
        });
      });
    });

    describe('Given no logger option', () => {
      describe('When a request is made', () => {
        it('Then no logging events are emitted', async () => {
          // Arrange
          const transport = new MemoryHttpTransport();
          setupMock(transport, 'https://example.com/');
          const ctx = createMemoryContext();
          const ctxWithTransport = { ...ctx, transport };
          const sut = withDefaults(ctxWithTransport);

          // Act
          const res = await sut.request({
            method: 'GET',
            url: 'https://example.com/',
            headers: {},
          });
          await drainBody(res.body);

          // Assert — no observable logger to assert against; success means no throw.
          expect(res.statusCode).toBe(200);
        });
      });
    });

    describe('Given a logger option', () => {
      describe('When a request is made', () => {
        it('Then the logger receives a sanitized request event', async () => {
          // Arrange
          const transport = new MemoryHttpTransport();
          setupMock(transport, 'https://example.com/');
          const ctx = createMemoryContext();
          const ctxWithTransport = { ...ctx, transport };
          const { logger, events } = collectLogs();
          const sut = withDefaults(ctxWithTransport, { logger });

          // Act
          const res = await sut.request({
            method: 'GET',
            url: 'https://example.com/',
            headers: {},
          });
          await drainBody(res.body);

          // Assert
          expect(events.length).toBeGreaterThanOrEqual(1);
          expect(events[0]?.kind).toBe('request');
        });
      });
    });

    describe('Given a response with CRLF in headers + a logger', () => {
      describe('When logged', () => {
        it('Then the recorded headers have escaped bytes', async () => {
          // Arrange
          const transport = new MemoryHttpTransport();
          setupMock(transport, 'https://example.com/', { 'x-evil': 'a\r\nb' });
          const ctx = createMemoryContext();
          const ctxWithTransport = { ...ctx, transport };
          const { logger, events } = collectLogs();
          const sut = withDefaults(ctxWithTransport, { logger });

          // Act
          const res = await sut.request({
            method: 'GET',
            url: 'https://example.com/',
            headers: {},
          });
          await drainBody(res.body);

          // Assert
          const responseEvent = events.find((e) => e.kind === 'response') as
            | (LogEvent & { kind: 'response' })
            | undefined;
          expect(responseEvent).toBeDefined();
          expect(responseEvent?.headers['x-evil']).toBe('a\\x0D\nb');
        });
      });
    });

    describe('Given an auth option', () => {
      describe('When a request is made', () => {
        it('Then the inner transport receives the Authorization header', async () => {
          // Arrange
          const transport = new MemoryHttpTransport();
          const seen: Record<string, string> = {};
          transport.request = vi.fn(async (req) => {
            for (const [k, v] of Object.entries(req.headers)) seen[k.toLowerCase()] = v as string;
            return {
              statusCode: 200,
              headers: {},
              body: new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
            };
          });
          const ctx = createMemoryContext();
          const ctxWithTransport = { ...ctx, transport };
          const sut = withDefaults(ctxWithTransport, {
            auth: { type: 'bearer', token: 'tok-123' },
          });

          // Act
          const res = await sut.request({
            method: 'GET',
            url: 'https://example.com/',
            headers: {},
          });
          await drainBody(res.body);

          // Assert
          expect(seen.authorization).toBe('Bearer tok-123');
        });
      });
    });

    describe('Given an auth option AND logger', () => {
      describe('When request is made', () => {
        it('Then the logger event does NOT contain the Authorization header (logging wraps before auth injection)', async () => {
          // Arrange — verify the security contract of the new pipeline order:
          // logger sees the request BEFORE withAuth injects credentials.
          const transport = new MemoryHttpTransport();
          setupMock(transport, 'https://example.com/');
          const ctx = createMemoryContext();
          const ctxWithTransport = { ...ctx, transport };
          const { logger, events } = collectLogs();
          const sut = withDefaults(ctxWithTransport, {
            auth: { type: 'bearer', token: 'secret-tok' },
            logger,
          });

          // Act
          const res = await sut.request({
            method: 'GET',
            url: 'https://example.com/',
            headers: {},
          });
          await drainBody(res.body);

          // Assert — request event must show empty headers, not the bearer token.
          const requestEvent = events.find((e) => e.kind === 'request') as
            | (LogEvent & { kind: 'request' })
            | undefined;
          expect(requestEvent).toBeDefined();
          expect(requestEvent?.headers.authorization).toBeUndefined();
          expect(requestEvent?.headers.Authorization).toBeUndefined();
        });
      });
    });

    describe('Given a transport that fails twice then succeeds + retry option', () => {
      describe('When called', () => {
        it('Then the request eventually succeeds', async () => {
          // Arrange
          const transport = new MemoryHttpTransport();
          let attempts = 0;
          transport.request = vi.fn(async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('transient');
            return {
              statusCode: 200,
              headers: {},
              body: new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
            };
          });
          const ctx = createMemoryContext();
          const ctxWithTransport = { ...ctx, transport };
          const sut = withDefaults(ctxWithTransport, {
            retry: {
              attempts: 5,
              backoff: 'fixed',
              baseMs: 1,
              maxDelayMs: 1,
              delay: async () => undefined,
            },
          });

          // Act
          const res = await sut.request({
            method: 'GET',
            url: 'https://example.com/',
            headers: {},
          });

          // Assert
          expect(attempts).toBe(3);
          expect(res.statusCode).toBe(200);
        });
      });
    });
  });
});

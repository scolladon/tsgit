import { vi } from 'vitest';

import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../src/ports/http-transport.js';
import type { LogEvent, Logger } from '../../../src/transport/types.js';

export interface RecordingLogger {
  readonly logger: Logger;
  readonly events: LogEvent[];
}

export const recordingLogger = (): RecordingLogger => {
  const events: LogEvent[] = [];
  const logger: Logger = {
    log: (e) => {
      events.push(e);
    },
  };
  return { logger, events };
};

export interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

export const fakeClock = (start = 0): FakeClock => {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
};

const emptyBody = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

export const makeRequest = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  url: 'https://example.com/repo.git/info/refs?service=git-upload-pack',
  method: 'GET',
  headers: {},
  ...overrides,
});

export const makeResponse = (overrides: Partial<HttpResponse> = {}): HttpResponse => ({
  statusCode: 200,
  headers: {},
  body: emptyBody(),
  ...overrides,
});

export interface FakeTransport {
  readonly transport: HttpTransport;
  readonly calls: HttpRequest[];
}

export const fakeTransport = (seq: ReadonlyArray<HttpResponse | Error>): FakeTransport => {
  const calls: HttpRequest[] = [];
  let i = 0;
  const transport: HttpTransport = {
    request: vi.fn<HttpTransport['request']>(async (req) => {
      calls.push(req);
      const next = seq[i] ?? seq[seq.length - 1];
      i += 1;
      if (next instanceof Error) throw next;
      if (!next) throw new Error('fakeTransport exhausted');
      return next;
    }),
  };
  return { transport, calls };
};

export interface PendingDelay {
  readonly ms: number;
  resolve(): void;
  reject(err: unknown): void;
}

export interface ControllableDelay {
  readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pending: PendingDelay[];
  readonly resolveNext: () => void;
}

export const controllableDelay = (): ControllableDelay => {
  const pending: PendingDelay[] = [];
  const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const entry: PendingDelay = {
        ms,
        resolve,
        reject,
      };
      const onAbort = (): void => {
        const idx = pending.indexOf(entry);
        if (idx >= 0) pending.splice(idx, 1);
        reject(signal?.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.push(entry);
    });
  const resolveNext = (): void => {
    const next = pending.shift();
    if (!next) throw new Error('no pending delay');
    next.resolve();
  };
  return { delay, pending, resolveNext };
};

export const bodyWithCancelSpy = (
  onCancel?: () => void,
): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancelSpy: () => number;
} => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      // Keep the stream readable so cancel() actually invokes the source.
    },
    cancel() {
      cancelled += 1;
      onCancel?.();
    },
  });
  return { body, cancelSpy: () => cancelled };
};

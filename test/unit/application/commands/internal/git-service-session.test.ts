/**
 * Unit tests for the `GitServiceSession` seam: the HTTP implementation wraps
 * today's discovery GET / exchange POST wire shape verbatim, and opening a
 * session against an SSH URL refuses inertly (real SSH transport is a later
 * part).
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { openGitSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../../src/ports/http-transport.js';

const ENCODER = new TextEncoder();
const OID_A = OID.from('a'.repeat(40));

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
}

const successAdvertisement = (): Uint8Array => {
  const header = encodePktStream([ENCODER.encode('# service=git-upload-pack\n')]);
  const refs = encodePktStream([ENCODER.encode(`${OID_A} refs/heads/main\0ofs-delta\n`)]);
  const out = new Uint8Array(header.length + refs.length);
  out.set(header, 0);
  out.set(refs, header.length);
  return out;
};

const fakeTransport = (
  statusCode: number,
  body: Uint8Array,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (req): Promise<HttpResponse> => {
      requests.push(req);
      return {
        statusCode,
        headers: {},
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice());
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, requests };
};

const contextWith = (transport: HttpTransport) => {
  const base = createMemoryContext();
  return { ...base, transport };
};

describe('openGitSession — http', () => {
  describe('Given an http(s) url', () => {
    describe('When openGitSession runs', () => {
      it('Then the session reports servicePrologue: true', () => {
        // Arrange
        const { transport } = fakeTransport(200, successAdvertisement());
        const ctx = contextWith(transport);

        // Act
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Assert
        expect(sut.servicePrologue).toBe(true);
      });
    });
  });
});

describe('GitServiceSession.advertisement (http)', () => {
  describe('Given a 200 discovery response', () => {
    describe('When advertisement() runs', () => {
      it('Then it GETs .../info/refs?service=git-upload-pack and yields the pkt lines', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, successAdvertisement());
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        const pkts = await collect(await session.advertisement());

        // Assert
        expect(requests[0]?.url).toBe(
          'https://example.com/r.git/info/refs?service=git-upload-pack',
        );
        expect(requests[0]?.method).toBe('GET');
        expect(requests[0]?.headers.accept).toBe('application/x-git-upload-pack-advertisement');
        expect(pkts.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Given the service is git-receive-pack', () => {
    describe('When advertisement() runs', () => {
      it('Then the accept header targets the receive-pack advertisement', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-receive-pack');

        // Act
        await session.advertisement();

        // Assert
        expect(requests[0]?.headers.accept).toBe('application/x-git-receive-pack-advertisement');
      });
    });
  });

  describe('Given a non-200 discovery response', () => {
    describe('When advertisement() runs', () => {
      it.each([
        401, 403, 404, 500, 502, 503,
      ] as const)('Then throws HTTP_ERROR (status %i) with a discovery-tagged reason', async (statusCode) => {
        // Arrange
        const { transport } = fakeTransport(statusCode, new Uint8Array(0));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await session.advertisement();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          statusCode?: number;
          reason?: string;
        };
        expect(data.code).toBe('HTTP_ERROR');
        expect(data.statusCode).toBe(statusCode);
        expect(data.reason).toContain('discovery');
        expect(data.reason).toContain(String(statusCode));
      });
    });
  });

  describe('Given a ctx with a signal', () => {
    describe('When advertisement() runs', () => {
      it('Then the request carries the signal', async () => {
        // Arrange
        const controller = new AbortController();
        const { transport, requests } = fakeTransport(200, successAdvertisement());
        const ctx = { ...contextWith(transport), signal: controller.signal };
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await session.advertisement();

        // Assert
        expect(requests[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given a ctx without a signal', () => {
    describe('When advertisement() runs', () => {
      it('Then the request omits the signal field entirely', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, successAdvertisement());
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await session.advertisement();

        // Assert
        expect(requests[0] && 'signal' in requests[0]).toBe(false);
      });
    });
  });
});

describe('GitServiceSession.exchange (http)', () => {
  describe('Given a 200 exchange response', () => {
    describe('When exchange() runs', () => {
      it('Then it POSTs the request bytes to .../git-upload-pack and yields the pkt lines', async () => {
        // Arrange
        const responseBody = encodePktStream([ENCODER.encode('NAK\n')]);
        const { transport, requests } = fakeTransport(200, responseBody);
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');
        const requestBytes = ENCODER.encode('0032want aaaa\n0000');

        // Act
        const pkts = await collect(await session.exchange(requestBytes));

        // Assert
        expect(requests[0]?.url).toBe('https://example.com/r.git/git-upload-pack');
        expect(requests[0]?.method).toBe('POST');
        expect(requests[0]?.headers['content-type']).toBe('application/x-git-upload-pack-request');
        expect(requests[0]?.headers.accept).toBe('application/x-git-upload-pack-result');
        expect(requests[0]?.body).toBe(requestBytes);
        expect(pkts.filter((p) => p.kind === 'data')).toHaveLength(1);
      });
    });
  });

  describe('Given the service is git-receive-pack', () => {
    describe('When exchange() runs', () => {
      it('Then it POSTs to .../git-receive-pack with the receive-pack headers', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-receive-pack');

        // Act
        await session.exchange(new Uint8Array(0));

        // Assert
        expect(requests[0]?.url).toBe('https://example.com/r.git/git-receive-pack');
        expect(requests[0]?.headers['content-type']).toBe('application/x-git-receive-pack-request');
        expect(requests[0]?.headers.accept).toBe('application/x-git-receive-pack-result');
      });
    });
  });

  describe('Given a base URL with a fragment', () => {
    describe('When exchange() runs', () => {
      it('Then throws INVALID_BASE_URL with a fragment-tagged reason', async () => {
        // Arrange
        const { transport } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git#frag', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await session.exchange(new Uint8Array(0));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('INVALID_BASE_URL');
        expect(data.reason).toContain('fragment');
      });
    });
  });

  describe('Given a malformed base URL', () => {
    describe('When exchange() runs', () => {
      it('Then throws INVALID_BASE_URL with an invalid-URL-tagged reason', async () => {
        // Arrange
        const { transport } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await session.exchange(new Uint8Array(0));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('INVALID_BASE_URL');
        expect(data.reason).toContain('invalid URL');
      });
    });
  });

  describe('Given a base URL with a trailing slash', () => {
    describe('When exchange() runs', () => {
      it('Then the exchange URL drops the doubled slash', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git/', 'git-upload-pack');

        // Act
        await session.exchange(new Uint8Array(0));

        // Assert
        expect(requests[0]?.url).toBe('https://example.com/r.git/git-upload-pack');
      });
    });
  });

  describe('Given a non-200 exchange response', () => {
    describe('When exchange() runs', () => {
      it.each([
        401, 403, 404, 500, 502, 503,
      ] as const)('Then throws HTTP_ERROR (status %i) with a service-tagged, non-discovery reason', async (statusCode) => {
        // Arrange
        const { transport } = fakeTransport(statusCode, new Uint8Array(0));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await session.exchange(new Uint8Array(0));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          statusCode?: number;
          reason?: string;
        };
        expect(data.code).toBe('HTTP_ERROR');
        expect(data.statusCode).toBe(statusCode);
        expect(data.reason).not.toContain('discovery');
        expect(data.reason).toContain('git-upload-pack');
        expect(data.reason).toContain(String(statusCode));
      });
    });
  });

  describe('Given a ctx with a signal', () => {
    describe('When exchange() runs', () => {
      it('Then the request carries the signal', async () => {
        // Arrange
        const controller = new AbortController();
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = { ...contextWith(transport), signal: controller.signal };
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await session.exchange(new Uint8Array(0));

        // Assert
        expect(requests[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given a ctx without a signal', () => {
    describe('When exchange() runs', () => {
      it('Then the request omits the signal field entirely', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await session.exchange(new Uint8Array(0));

        // Assert
        expect(requests[0] && 'signal' in requests[0]).toBe(false);
      });
    });
  });
});

describe('GitServiceSession.close (http)', () => {
  describe('Given an open http session', () => {
    describe('When close() runs', () => {
      it('Then it resolves without error', async () => {
        // Arrange
        const { transport } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act & Assert
        await expect(session.close()).resolves.toBeUndefined();
      });
    });
  });
});

describe('openGitSession — ssh (inert refusal)', () => {
  describe('Given ctx.runtime is browser', () => {
    describe('When openGitSession runs with an ssh:// url', () => {
      it('Then throws ADAPTER_UNAVAILABLE tagged with the browser runtime', () => {
        // Arrange
        const ctx = { ...createMemoryContext(), runtime: 'browser' as const };

        // Act
        let caught: unknown;
        try {
          openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; runtime?: string };
        expect(data.code).toBe('ADAPTER_UNAVAILABLE');
        expect(data.runtime).toBe('browser');
      });
    });
  });

  describe('Given ctx.runtime is memory', () => {
    describe('When openGitSession runs with an ssh:// url', () => {
      it('Then throws ADAPTER_UNAVAILABLE tagged with the memory runtime', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-receive-pack');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; runtime?: string };
        expect(data.code).toBe('ADAPTER_UNAVAILABLE');
        expect(data.runtime).toBe('memory');
      });
    });
  });
});

describe('GitServiceSession.exchange — response decoding', () => {
  describe('Given a NAK response body', () => {
    describe('When exchange() runs', () => {
      it('Then the decoded pkt line carries the NAK payload bytes', async () => {
        // Arrange
        const nakPayload = ENCODER.encode('NAK\n');
        const { transport } = fakeTransport(200, encodePktStream([nakPayload]));
        const ctx = contextWith(transport);
        const session = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        const pkts = await collect(await session.exchange(new Uint8Array(0)));
        const dataPkts = pkts.filter((p) => p.kind === 'data');

        // Assert
        expect(dataPkts).toHaveLength(1);
        const [pkt] = dataPkts;
        expect(pkt?.kind === 'data' ? pkt.payload : undefined).toEqual(nakPayload);
      });
    });
  });
});

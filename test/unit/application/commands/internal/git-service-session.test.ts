/**
 * Unit tests for the `GitServiceSession` seam: the HTTP implementation wraps
 * today's discovery GET / exchange POST wire shape verbatim. Opening a
 * session against an SSH URL with no `ctx.ssh` refuses inertly; with
 * `ctx.ssh` present, it spawns a real channel shared across
 * `advertisement()` and `exchange()`.
 */
import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { openGitSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import {
  DELIM_PKT,
  encodePktLine,
  encodePktStream,
  FLUSH_PKT,
  type PktLine,
} from '../../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../../src/ports/http-transport.js';
import type {
  SshChannel,
  SshSpawnRequest,
  SshTransport,
} from '../../../../../src/ports/ssh-channel.js';

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

/**
 * Mirrors how a real advertisement consumer (`parseAdvertisedRefs`) drains a
 * pkt-line stream: read until the terminating flush, then `return()` in a
 * `finally` — never draining to the source's own `done`. Proves the SSH
 * session's shared iterator survives that early cleanup.
 */
async function collectUntilFlush(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const iterator = source[Symbol.asyncIterator]();
  const out: PktLine[] = [];
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) return out;
      out.push(value);
      if (value.kind === 'flush') return out;
    }
  } finally {
    await iterator.return?.();
  }
}

const fakeChannel = (opts: {
  readonly chunks?: ReadonlyArray<Uint8Array>;
  readonly exitCode?: number;
}): {
  readonly channel: SshChannel;
  readonly stdinWrites: Uint8Array[];
  readonly closeSpy: ReturnType<typeof vi.fn>;
} => {
  const stdinWrites: Uint8Array[] = [];
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of opts.chunks ?? []) controller.enqueue(chunk);
      controller.close();
    },
  });
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      stdinWrites.push(chunk);
    },
  });
  const closeSpy = vi.fn(async () => undefined);
  const channel: SshChannel = {
    stdin,
    stdout,
    exit: Promise.resolve(opts.exitCode ?? 0),
    close: closeSpy,
  };
  return { channel, stdinWrites, closeSpy };
};

const fakeSshTransport = (
  channel: SshChannel,
): { readonly ssh: SshTransport; readonly openSpy: ReturnType<typeof vi.fn> } => {
  const openSpy = vi.fn(async (_req: SshSpawnRequest) => channel);
  return { ssh: { open: openSpy }, openSpy };
};

const contextWithSsh = (ssh: SshTransport) => {
  const base = createMemoryContext();
  return { ...base, ssh };
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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        const pkts = await collect(await sut.advertisement());

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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-receive-pack');

        // Act
        await sut.advertisement();

        // Assert
        expect(requests[0]?.headers.accept).toBe('application/x-git-receive-pack-advertisement');
      });
    });
  });

  describe('Given the service is git-upload-pack', () => {
    describe('When advertisement() runs', () => {
      it('Then it carries the Git-Protocol: version=2 header', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, successAdvertisement());
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await sut.advertisement();

        // Assert
        expect(requests[0]?.headers['git-protocol']).toBe('version=2');
      });
    });
  });

  describe('Given the service is git-receive-pack', () => {
    describe('When advertisement() runs', () => {
      it('Then it carries no Git-Protocol header', async () => {
        // Arrange — v2 is upload-pack (fetch-side) negotiation only; push
        // stays v1.
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-receive-pack');

        // Act
        await sut.advertisement();

        // Assert
        expect(requests[0]?.headers['git-protocol']).toBeUndefined();
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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await sut.advertisement();
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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await sut.advertisement();

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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await sut.advertisement();

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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');
        const requestBytes = ENCODER.encode('0032want aaaa\n0000');

        // Act
        const pkts = await collect(await sut.exchange(requestBytes));

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

  describe('Given a v2 fetch response body with a section-delim pkt-line', () => {
    describe('When exchange() runs', () => {
      it('Then it decodes the delim pkt-line instead of throwing a reserved-length error', async () => {
        // Arrange — a real v2 `fetch` response separates named sections
        // (e.g. `wanted-refs` / `packfile`) with the reserved length `0001`.
        // Decoding this response without the `{ v2: true }` pkt-line option
        // would reject that reserved length instead of yielding `kind: 'delim'`.
        const body = new Uint8Array([
          ...encodePktLine(ENCODER.encode('wanted-refs\n')),
          ...DELIM_PKT,
          ...encodePktLine(ENCODER.encode('packfile\n')),
          ...FLUSH_PKT,
        ]);
        const { transport } = fakeTransport(200, body);
        const sut = openGitSession(
          contextWith(transport),
          'https://example.com/repo.git',
          'git-upload-pack',
        );

        // Act
        const pkts = await collect(await sut.exchange(ENCODER.encode('0000')));

        // Assert
        expect(pkts.map((p) => p.kind)).toEqual(['data', 'delim', 'data', 'flush']);
      });
    });
  });

  describe('Given the service is git-receive-pack', () => {
    describe('When exchange() runs', () => {
      it('Then it POSTs to .../git-receive-pack with the receive-pack headers', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-receive-pack');

        // Act
        await sut.exchange(new Uint8Array(0));

        // Assert
        expect(requests[0]?.url).toBe('https://example.com/r.git/git-receive-pack');
        expect(requests[0]?.headers['content-type']).toBe('application/x-git-receive-pack-request');
        expect(requests[0]?.headers.accept).toBe('application/x-git-receive-pack-result');
      });
    });
  });

  describe('Given the service is git-upload-pack', () => {
    describe('When exchange() runs', () => {
      it('Then the POST carries the Git-Protocol: version=2 header', async () => {
        // Arrange
        const responseBody = encodePktStream([ENCODER.encode('NAK\n')]);
        const { transport, requests } = fakeTransport(200, responseBody);
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await sut.exchange(ENCODER.encode('0032want aaaa\n0000'));

        // Assert
        expect(requests[0]?.headers['git-protocol']).toBe('version=2');
      });
    });
  });

  describe('Given the service is git-receive-pack', () => {
    describe('When exchange() runs', () => {
      it('Then the POST carries no Git-Protocol header', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-receive-pack');

        // Act
        await sut.exchange(new Uint8Array(0));

        // Assert
        expect(requests[0]?.headers['git-protocol']).toBeUndefined();
      });
    });
  });

  describe('Given a base URL with a fragment', () => {
    describe('When exchange() runs', () => {
      it('Then throws INVALID_BASE_URL with a fragment-tagged reason', async () => {
        // Arrange
        const { transport } = fakeTransport(200, encodePktStream([]));
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/r.git#frag', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await sut.exchange(new Uint8Array(0));
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
        const sut = openGitSession(ctx, 'https://', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await sut.exchange(new Uint8Array(0));
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
        const sut = openGitSession(ctx, 'https://example.com/r.git/', 'git-upload-pack');

        // Act
        await sut.exchange(new Uint8Array(0));

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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await sut.exchange(new Uint8Array(0));
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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await sut.exchange(new Uint8Array(0));

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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        await sut.exchange(new Uint8Array(0));

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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act & Assert
        await expect(sut.close()).resolves.toBeUndefined();
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
        const sut = openGitSession(ctx, 'https://example.com/r.git', 'git-upload-pack');

        // Act
        const pkts = await collect(await sut.exchange(new Uint8Array(0)));
        const dataPkts = pkts.filter((p) => p.kind === 'data');

        // Assert
        expect(dataPkts).toHaveLength(1);
        const [pkt] = dataPkts;
        expect(pkt?.kind === 'data' ? pkt.payload : undefined).toEqual(nakPayload);
      });
    });
  });
});

describe('openGitSession — ssh (real channel)', () => {
  describe('Given ctx.ssh is a real transport', () => {
    describe('When openGitSession runs with an ssh:// url', () => {
      it('Then the session reports servicePrologue: false', () => {
        // Arrange
        const { channel } = fakeChannel({});
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);

        // Act
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Assert
        expect(sut.servicePrologue).toBe(false);
      });
    });

    describe('When advertisement() runs', () => {
      it('Then it spawns the resolved ssh program with the service argv', async () => {
        // Arrange
        const { channel } = fakeChannel({});
        const { ssh, openSpy } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        await collectUntilFlush(await sut.advertisement());

        // Assert
        expect(openSpy).toHaveBeenCalledWith({
          command: 'ssh',
          args: ['git@example.com', "git-upload-pack '/repo.git'"],
          env: {},
        });
      });
    });
  });
});

describe('GitServiceSession.advertisement (ssh)', () => {
  describe('Given an ssh channel carrying a ref advertisement with no service prologue', () => {
    describe('When advertisement() runs', () => {
      it('Then it decodes the ref advertisement pkt-lines', async () => {
        // Arrange
        const refLine = ENCODER.encode(`${OID_A} refs/heads/main\0ofs-delta\n`);
        const { channel } = fakeChannel({ chunks: [encodePktStream([refLine])] });
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        const pkts = await collectUntilFlush(await sut.advertisement());
        const dataPkts = pkts.filter((p) => p.kind === 'data');

        // Assert
        expect(dataPkts).toHaveLength(1);
        expect(dataPkts[0]?.kind === 'data' ? dataPkts[0].payload : undefined).toEqual(refLine);
      });
    });
  });
});

describe('GitServiceSession.exchange (ssh)', () => {
  describe('Given an already-consumed advertisement on the same persistent channel', () => {
    describe('When exchange() runs', () => {
      it('Then it writes the request bytes to the channel stdin', async () => {
        // Arrange
        const advertisementBytes = encodePktStream([ENCODER.encode(`${OID_A} refs/heads/main\n`)]);
        const exchangeBytes = encodePktStream([ENCODER.encode('NAK\n')]);
        const { channel, stdinWrites } = fakeChannel({
          chunks: [advertisementBytes, exchangeBytes],
        });
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');
        await collectUntilFlush(await sut.advertisement());
        const requestBytes = ENCODER.encode('0011want abc\n0000');

        // Act
        await sut.exchange(requestBytes);

        // Assert
        expect(stdinWrites).toEqual([requestBytes]);
      });

      it('Then it continues decoding the shared stream from where the advertisement left off', async () => {
        // Arrange
        const advertisementBytes = encodePktStream([ENCODER.encode(`${OID_A} refs/heads/main\n`)]);
        const exchangeBytes = encodePktStream([ENCODER.encode('NAK\n')]);
        const { channel } = fakeChannel({ chunks: [advertisementBytes, exchangeBytes] });
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');
        await collectUntilFlush(await sut.advertisement());

        // Act
        const pkts = await collect(await sut.exchange(new Uint8Array(0)));
        const dataPkts = pkts.filter((p) => p.kind === 'data');

        // Assert
        expect(dataPkts).toHaveLength(1);
        expect(dataPkts[0]?.kind === 'data' ? dataPkts[0].payload : undefined).toEqual(
          ENCODER.encode('NAK\n'),
        );
      });
    });
  });
});

describe('GitServiceSession.close (ssh)', () => {
  describe('Given the channel was opened by a prior advertisement() call', () => {
    describe('When close() runs', () => {
      it('Then it closes the underlying channel exactly once', async () => {
        // Arrange
        const { channel, closeSpy } = fakeChannel({});
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');
        await collectUntilFlush(await sut.advertisement());

        // Act
        await sut.close();

        // Assert
        expect(closeSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given the channel was never opened', () => {
    describe('When close() runs', () => {
      it('Then it resolves without ever spawning a channel', async () => {
        // Arrange
        const { channel, closeSpy } = fakeChannel({});
        const { ssh, openSpy } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        await sut.close();

        // Assert
        expect(openSpy).not.toHaveBeenCalled();
        expect(closeSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('GitServiceSession — ssh non-zero exit', () => {
  describe('Given the ssh channel exits non-zero with no bytes on stdout', () => {
    describe('When advertisement() is consumed', () => {
      it('Then it throws NETWORK_ERROR carrying the exit code', async () => {
        // Arrange
        const { channel } = fakeChannel({ exitCode: 128 });
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await collect(await sut.advertisement());
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('NETWORK_ERROR');
        expect(data.reason).toContain('128');
      });
    });
  });

  describe('Given a live (non-aborted) signal and an ssh channel exiting non-zero', () => {
    describe('When advertisement() is consumed', () => {
      it('Then it still throws NETWORK_ERROR (abort translation needs an actual abort)', async () => {
        // Arrange
        const controller = new AbortController();
        const { channel } = fakeChannel({ exitCode: 128 });
        const { ssh } = fakeSshTransport(channel);
        const ctx = { ...contextWithSsh(ssh), signal: controller.signal };
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await collect(await sut.advertisement());
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('NETWORK_ERROR');
        expect(data.reason).toContain('128');
      });
    });
  });

  describe('Given an aborted context whose killed ssh child exits non-zero', () => {
    describe('When advertisement() is consumed', () => {
      it('Then the failure surfaces as OPERATION_ABORTED, not a network error', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const { channel } = fakeChannel({ exitCode: 128 });
        const { ssh } = fakeSshTransport(channel);
        const ctx = { ...contextWithSsh(ssh), signal: controller.signal };
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        let caught: unknown;
        try {
          await collect(await sut.advertisement());
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string };
        expect(data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});

describe('GitServiceSession — ssh duplex exchange', () => {
  describe('Given an ssh channel whose stdin write settles only after the response is consumed', () => {
    describe('When exchange() runs over the duplex channel', () => {
      it('Then the response streams before the write settles (no duplex deadlock)', async () => {
        // Arrange — a stdin sink stalled until the test releases it: an
        // implementation that awaits the write before reading stdout can
        // never finish this test.
        let releaseWrite: (() => void) | undefined;
        const writeGate = new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        let writeSettled = false;
        const stdin = new WritableStream<Uint8Array>({
          write: async () => {
            await writeGate;
            writeSettled = true;
          },
        });
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodePktStream([ENCODER.encode('NAK\n')]));
            controller.close();
          },
        });
        const closeSpy = vi.fn(async () => undefined);
        const channel: SshChannel = { stdin, stdout, exit: Promise.resolve(0), close: closeSpy };
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act — resolves only when the write is not awaited up front.
        const response = await sut.exchange(ENCODER.encode('0000'));
        const iterator = response[Symbol.asyncIterator]();
        const first = await iterator.next();

        // Assert — data flowed while the write was still pending.
        expect(writeSettled).toBe(false);
        expect(first.done).toBe(false);
        releaseWrite?.();
        const flush = await iterator.next();
        expect(flush.done).toBe(false);
        const last = await iterator.next();
        expect(last.done).toBe(true);
        expect(writeSettled).toBe(true);
      });
    });
  });

  describe('Given an ssh channel whose stdin rejects the request write', () => {
    describe('When the exchange response is consumed to its natural end', () => {
      it('Then the parked write failure surfaces instead of being swallowed', async () => {
        // Arrange
        const writeError = new Error('stdin write failed');
        const stdin = new WritableStream<Uint8Array>({
          write: () => Promise.reject(writeError),
        });
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodePktStream([ENCODER.encode('NAK\n')]));
            controller.close();
          },
        });
        const closeSpy = vi.fn(async () => undefined);
        const channel: SshChannel = { stdin, stdout, exit: Promise.resolve(0), close: closeSpy };
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        const response = await sut.exchange(ENCODER.encode('0000'));
        let caught: unknown;
        try {
          await collect(response);
        } catch (err) {
          caught = err;
        }

        // Assert — the exact parked rejection, surfaced at stream end.
        expect(caught).toBe(writeError);
      });
    });
  });

  describe('Given a persistent ssh channel', () => {
    describe('When exchange() runs twice on the same session', () => {
      it('Then both writes land — the stdin writer lock is released between writes', async () => {
        // Arrange
        const { channel, stdinWrites } = fakeChannel({
          chunks: [encodePktStream([ENCODER.encode('NAK\n')])],
        });
        const { ssh } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        await sut.exchange(ENCODER.encode('first'));
        await sut.exchange(ENCODER.encode('second'));

        // Assert — a retained lock would make the second getWriter() throw.
        expect(stdinWrites).toHaveLength(2);
        expect(stdinWrites[1]).toEqual(ENCODER.encode('second'));
      });
    });
  });
});

describe('GitServiceSession — spawn request shape', () => {
  describe('Given a context without an abort signal', () => {
    describe('When the ssh channel is spawned', () => {
      it('Then the spawn request carries no signal key at all', async () => {
        // Arrange
        const { channel } = fakeChannel({ chunks: [] });
        const { ssh, openSpy } = fakeSshTransport(channel);
        const ctx = contextWithSsh(ssh);
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        await sut.advertisement();

        // Assert — key absence, not undefined-value equality.
        expect(Object.keys(openSpy.mock.calls[0]?.[0] as object)).not.toContain('signal');
      });
    });
  });

  describe('Given a context carrying an abort signal', () => {
    describe('When the ssh channel is spawned', () => {
      it('Then the spawn request carries that exact signal instance', async () => {
        // Arrange
        const controller = new AbortController();
        const { channel } = fakeChannel({ chunks: [] });
        const { ssh, openSpy } = fakeSshTransport(channel);
        const ctx = { ...contextWithSsh(ssh), signal: controller.signal };
        const sut = openGitSession(ctx, 'ssh://git@example.com/repo.git', 'git-upload-pack');

        // Act
        await sut.advertisement();

        // Assert
        const request = openSpy.mock.calls[0]?.[0] as { signal?: AbortSignal };
        expect(request.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given an http remote', () => {
    describe('When the advertisement GET is issued', () => {
      it('Then the request carries no body key at all', async () => {
        // Arrange
        const { transport, requests } = fakeTransport(200, successAdvertisement());
        const ctx = contextWith(transport);
        const sut = openGitSession(ctx, 'https://example.com/repo.git', 'git-upload-pack');

        // Act
        await sut.advertisement();

        // Assert — key absence, not undefined-value equality.
        expect(Object.keys(requests[0] as object)).not.toContain('body');
      });
    });
  });
});

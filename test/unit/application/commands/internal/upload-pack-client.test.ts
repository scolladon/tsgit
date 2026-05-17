/**
 * Unit tests for the shared `upload-pack-client` helpers. Pins behaviour
 * that the broader `fetch`/`clone` tests reach indirectly so Stryker can
 * see kills against each individual line.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  discoverRefs,
  selectFetchCapabilities,
  uniqueRefOids,
} from '../../../../../src/application/commands/internal/upload-pack-client.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import { encodePktStream } from '../../../../../src/domain/protocol/pkt-line.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../../src/ports/http-transport.js';

const ENCODER = new TextEncoder();
const OID_A = OID.from('a'.repeat(40));
const OID_B = OID.from('b'.repeat(40));

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

describe('discoverRefs', () => {
  it('Given a 200 response carrying a valid advertisement, When discoverRefs runs, Then the Advertisement is returned', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const { transport } = fakeTransport(200, successAdvertisement());

    // Act
    const sut = await discoverRefs(ctx, transport, 'https://example.com/r.git');

    // Assert
    expect(sut.refs.length).toBe(1);
    expect(sut.refs[0]?.name).toBe('refs/heads/main');
  });

  it.each([
    401, 403, 404, 500, 502, 503,
  ] as const)('Given a non-200 response (status %s), When discoverRefs runs, Then throws HTTP_ERROR with the status code and a discovery-tagged reason', async (statusCode) => {
    // Arrange — kills `if (response.statusCode !== 200) throw httpError` AND
    // the StringLiteral mutant on the `discovery returned ...` reason text
    // (the message must mention `discovery` so callers can distinguish a
    // discovery failure from a pack POST failure).
    const ctx = createMemoryContext();
    const { transport } = fakeTransport(statusCode, new Uint8Array(0));

    // Act
    let caught: unknown;
    try {
      await discoverRefs(ctx, transport, 'https://example.com/r.git');
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

  it('Given the request, When discoverRefs runs, Then the `accept` header equals `application/x-git-upload-pack-advertisement`', async () => {
    // Arrange — kills the `{ accept: '...' }` → `{}` ObjectLiteral mutant
    // and the StringLiteral mutant on the accept value.
    const ctx = createMemoryContext();
    const { transport, requests } = fakeTransport(200, successAdvertisement());

    // Act
    await discoverRefs(ctx, transport, 'https://example.com/r.git');

    // Assert
    expect(requests[0]?.headers.accept).toBe('application/x-git-upload-pack-advertisement');
  });

  it('Given a ctx with a signal, When discoverRefs runs, Then the request carries the signal', async () => {
    // Arrange — kills the `ctx.signal !== undefined ? { signal } : {}` mutant.
    const baseCtx = createMemoryContext();
    const controller = new AbortController();
    const ctx = { ...baseCtx, signal: controller.signal };
    const { transport, requests } = fakeTransport(200, successAdvertisement());

    // Act
    await discoverRefs(ctx, transport, 'https://example.com/r.git');

    // Assert
    expect(requests[0]?.signal).toBe(controller.signal);
  });

  it('Given a ctx without a signal, When discoverRefs runs, Then the request omits the signal field entirely', async () => {
    // Arrange — pins the false branch of the same ternary.
    const ctx = createMemoryContext();
    const { transport, requests } = fakeTransport(200, successAdvertisement());

    // Act
    await discoverRefs(ctx, transport, 'https://example.com/r.git');

    // Assert
    expect(requests[0] && 'signal' in requests[0]).toBe(false);
  });
});

describe('selectFetchCapabilities', () => {
  it('Given an advertised set, When selectFetchCapabilities runs, Then the agent string is always appended', async () => {
    // Arrange & Act
    const sut = selectFetchCapabilities(['side-band-64k']);

    // Assert — the AGENT slot is always sent regardless of server advert.
    expect(sut.some((c) => c.startsWith('agent='))).toBe(true);
  });

  it.each([
    ['multi_ack_detailed'],
    ['thin-pack'],
    ['no-progress'],
  ] as const)('Given the server advertises %s, When selectFetchCapabilities runs, Then it is NOT included in the result', async (cap) => {
    // Arrange & Act — kills each of the four `c !== '<cap>'` mutants
    // inside the filter on line 68.
    const sut = selectFetchCapabilities([cap, 'side-band-64k']);

    // Assert
    expect(sut).not.toContain(cap);
  });

  it('Given the server does NOT advertise side-band-64k, When selectFetchCapabilities runs, Then side-band-64k is NOT in the result', async () => {
    // Arrange & Act — kills the `.filter` → no-filter mutant; without the
    // intersect step, capabilities the server doesn't support would still
    // be sent.
    const sut = selectFetchCapabilities([]);

    // Assert
    expect(sut).not.toContain('side-band-64k');
  });

  it('Given the server advertises only side-band-64k, When selectFetchCapabilities runs, Then side-band-64k IS in the result', async () => {
    // Arrange & Act
    const sut = selectFetchCapabilities(['side-band-64k']);

    // Assert
    expect(sut).toContain('side-band-64k');
  });

  it('Given the server advertises its own agent string, When selectFetchCapabilities runs, Then the agent slot is NOT duplicated', async () => {
    // Arrange — kills the `c !== AGENT` filter mutant on the last
    // conjunct. With the mutant, AGENT would survive the intersect step
    // and then get appended a SECOND time at the end of the function.
    const sut = selectFetchCapabilities(['agent=git/2.x', 'side-band-64k']);

    // Assert — exactly one agent= entry, and it is the client's, not
    // the server's leaked echo.
    const agentEntries = sut.filter((c) => c.startsWith('agent='));
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0]).not.toBe('agent=git/2.x');
  });
});

describe('uniqueRefOids', () => {
  it('Given two refs sharing the same oid, When uniqueRefOids runs, Then the oid appears once in the result', async () => {
    // Arrange — kills the `if (seen.has(r.id)) continue` mutant.
    const refs = [
      { name: 'refs/heads/main', id: OID_A },
      { name: 'refs/heads/release', id: OID_A },
      { name: 'refs/tags/v1', id: OID_B },
    ];

    // Act
    const sut = uniqueRefOids(refs);

    // Assert
    expect(sut).toEqual([OID_A, OID_B] as ObjectId[]);
  });

  it('Given an empty refs list, When uniqueRefOids runs, Then returns an empty array', async () => {
    // Arrange & Act
    const sut = uniqueRefOids([]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given refs with distinct oids, When uniqueRefOids runs, Then preserves insertion order', async () => {
    // Arrange
    const refs = [
      { name: 'refs/heads/a', id: OID_B },
      { name: 'refs/heads/b', id: OID_A },
    ];

    // Act
    const sut = uniqueRefOids(refs);

    // Assert
    expect(sut).toEqual([OID_B, OID_A] as ObjectId[]);
  });
});

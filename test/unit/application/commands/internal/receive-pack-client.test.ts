/**
 * Unit tests for the receive-pack client helpers.
 *
 * Mirrors the upload-pack-client.test.ts contract:
 *  - discoverReceivePackRefs makes the right HTTP request.
 *  - selectPushCapabilities intersects + appends the agent slot.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  discoverReceivePackRefs,
  selectPushCapabilities,
} from '../../../../../src/application/commands/internal/receive-pack-client.js';
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

const successAdvertisement = (): Uint8Array => {
  const header = encodePktStream([ENCODER.encode('# service=git-receive-pack\n')]);
  const refs = encodePktStream([
    ENCODER.encode(`${OID_A} refs/heads/main\0report-status atomic side-band-64k\n`),
  ]);
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

describe('discoverReceivePackRefs', () => {
  describe('Given a 200 response with a valid receive-pack advertisement', () => {
    describe('When discoverReceivePackRefs runs', () => {
      it('Then the Advertisement is parsed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { transport, requests } = fakeTransport(200, successAdvertisement());

        // Act
        const sut = await discoverReceivePackRefs(ctx, transport, 'https://example.com/r.git');

        // Assert — request shape pins service parameter end-to-end.
        expect(requests[0]?.url).toContain('service=git-receive-pack');
        expect(requests[0]?.headers.accept).toBe('application/x-git-receive-pack-advertisement');
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.name).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a 401 response', () => {
    describe('When discoverReceivePackRefs runs', () => {
      it('Then throws HTTP_ERROR mentioning receive-pack', async () => {
        // Arrange — kills the StringLiteral mutant on `git-receive-pack` reason.
        const ctx = createMemoryContext();
        const { transport } = fakeTransport(401, new Uint8Array(0));

        // Act
        let caught: unknown;
        try {
          await discoverReceivePackRefs(ctx, transport, 'https://example.com/r.git');
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
        expect(data.statusCode).toBe(401);
        expect(data.reason).toContain('git-receive-pack');
      });
    });
  });
});

describe('selectPushCapabilities', () => {
  describe('Given an advertised set with only report-status', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then the agent slot is always appended', () => {
        // Arrange & Act
        const sut = selectPushCapabilities(['report-status']);

        // Assert — pins the trailing `[...intersected, AGENT]` step.
        expect(sut.some((c) => c.startsWith('agent='))).toBe(true);
      });
    });
  });

  describe('Given server advertises only %s', () => {
    describe('When selectPushCapabilities runs', () => {
      it.each([
        ['report-status'],
        ['side-band-64k'],
        ['ofs-delta'],
        ['atomic'],
        ['delete-refs'],
      ] as const)('Then %s IS in the result', (cap) => {
        // Arrange & Act
        const sut = selectPushCapabilities([cap]);

        // Assert — the intersect keeps any v1-supported capability.
        expect(sut).toContain(cap);
      });
    });
  });

  describe('Given the server advertises a non-supported capability', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then it is NOT in the result', () => {
        // Arrange & Act — kills the no-intersect mutant. Without the intersect
        // step, the function would echo unsupported capabilities back to the
        // server.
        const sut = selectPushCapabilities(['quiet']);

        // Assert
        expect(sut).not.toContain('quiet');
      });
    });
  });

  describe('Given the server advertises its own agent string', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then the result has exactly one agent= entry (the client one)', () => {
        // Arrange — kills the `c !== AGENT` filter mutant on the clientWants
        // step. Without it, AGENT would survive the intersect and then get
        // appended again at the end, producing two agent= entries.
        const sut = selectPushCapabilities(['agent=git/2.x', 'report-status']);

        // Assert
        const agentEntries = sut.filter((c) => c.startsWith('agent='));
        expect(agentEntries).toHaveLength(1);
        expect(agentEntries[0]).not.toBe('agent=git/2.x');
      });
    });
  });

  describe('Given the server does NOT advertise atomic', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then atomic is NOT in the result', () => {
        // Arrange — pins the negotiation contract: we only ask for what the
        // server can give us.
        const sut = selectPushCapabilities(['report-status']);

        // Assert
        expect(sut).not.toContain('atomic');
      });
    });
  });
});

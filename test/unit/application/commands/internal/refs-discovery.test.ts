/**
 * Unit tests for the parameterised `discoverRefsForService` helper.
 *
 * The upload-pack-bound `discoverRefs` wrapper is exercised in
 * `upload-pack-client.test.ts`. These tests pin the service parameterisation:
 * each branch of the `ACCEPT_HEADER` table, plus the URL `service=` query.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { discoverRefsForService } from '../../../../../src/application/commands/internal/refs-discovery.js';
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

const advertisementBody = (service: string): Uint8Array => {
  const header = encodePktStream([ENCODER.encode(`# service=${service}\n`)]);
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

describe('discoverRefsForService', () => {
  describe('Given service %s', () => {
    describe('When discoverRefsForService runs', () => {
      it.each([
        [
          'git-upload-pack',
          'application/x-git-upload-pack-advertisement',
          'service=git-upload-pack',
        ],
        [
          'git-receive-pack',
          'application/x-git-receive-pack-advertisement',
          'service=git-receive-pack',
        ],
      ] as const)('Then accept=%s and URL carries %s', async (service, expectedAccept, expectedQueryFragment) => {
        // Arrange — pins the per-service ACCEPT_HEADER map AND the
        // `${service} discovery returned ${code}` error template; both must be
        // service-specific so callers can distinguish upload-pack vs receive-pack
        // failures at the error layer.
        const ctx = createMemoryContext();
        const { transport, requests } = fakeTransport(200, advertisementBody(service));

        // Act
        const sut = await discoverRefsForService(
          ctx,
          transport,
          'https://example.com/r.git',
          service,
        );

        // Assert — request shape
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toContain(expectedQueryFragment);
        expect(requests[0]?.headers.accept).toBe(expectedAccept);
        // Assert — advertisement round-tripped
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.name).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a non-200 response from git-receive-pack', () => {
    describe('When discoverRefsForService runs', () => {
      it('Then HTTP_ERROR reason mentions the service', async () => {
        // Arrange — kills the StringLiteral mutant on the error message: callers
        // rely on `${service}` being present so a discovery failure on push is
        // not mis-attributed to a fetch flow.
        const ctx = createMemoryContext();
        const { transport } = fakeTransport(403, new Uint8Array(0));

        // Act
        let caught: unknown;
        try {
          await discoverRefsForService(
            ctx,
            transport,
            'https://example.com/r.git',
            'git-receive-pack',
          );
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
        expect(data.statusCode).toBe(403);
        expect(data.reason).toContain('git-receive-pack');
        expect(data.reason).toContain('403');
      });
    });
  });
});

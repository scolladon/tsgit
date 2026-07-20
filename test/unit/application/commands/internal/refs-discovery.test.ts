/**
 * Unit tests for the parameterised `discoverRefsForService` helper.
 *
 * The upload-pack-bound `discoverRefs` wrapper is exercised in
 * `upload-pack-client.test.ts`; the receive-pack-bound `discoverReceivePackRefs`
 * wrapper in `receive-pack-client.test.ts`. The session's own HTTP wiring
 * (accept header per service, discovery URL, non-200 handling) is exercised in
 * `git-service-session.test.ts`. These tests pin what `discoverRefsForService`
 * itself still owns: threading `service` and `session.servicePrologue` through
 * to `parseAdvertisedRefs`.
 */
import { describe, expect, it } from 'vitest';
import type { GitServiceSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import { discoverRefsForService } from '../../../../../src/application/commands/internal/refs-discovery.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../../src/domain/protocol/pkt-line.js';

const ENCODER = new TextEncoder();
const OID_A = OID.from('a'.repeat(40));

const asyncBytes = async function* (chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
};

const advertisementBody = (service: string): Uint8Array => {
  const header = encodePktStream([ENCODER.encode(`# service=${service}\n`)]);
  const refs = encodePktStream([ENCODER.encode(`${OID_A} refs/heads/main\0ofs-delta\n`)]);
  const out = new Uint8Array(header.length + refs.length);
  out.set(header, 0);
  out.set(refs, header.length);
  return out;
};

interface FakeSessionOptions {
  readonly body: Uint8Array;
  readonly servicePrologue?: boolean;
}

const fakeSession = (opts: FakeSessionOptions): GitServiceSession => ({
  advertisement: (): Promise<AsyncIterable<PktLine>> =>
    Promise.resolve(decodePktStream(asyncBytes([opts.body]))),
  exchange: () => Promise.reject(new Error('not implemented')),
  close: () => Promise.resolve(),
  servicePrologue: opts.servicePrologue ?? true,
});

describe('discoverRefsForService', () => {
  describe('Given service %s', () => {
    describe('When discoverRefsForService runs', () => {
      it.each([['git-upload-pack'], ['git-receive-pack']] as const)(
        'Then the %s advertisement is parsed',
        async (service) => {
          // Arrange
          const session = fakeSession({ body: advertisementBody(service) });

          // Act
          const sut = await discoverRefsForService(session, service);

          // Assert
          expect(sut.refs).toHaveLength(1);
          expect(sut.refs[0]?.name).toBe('refs/heads/main');
        },
      );
    });
  });

  describe('Given a session with servicePrologue: false', () => {
    describe('When discoverRefsForService runs', () => {
      it('Then the advertisement is parsed without expecting the service header', async () => {
        // Arrange — a prologue-less (SSH-style) body has no `# service=...`
        // line; pins that discoverRefsForService threads
        // `session.servicePrologue` through rather than hardcoding the HTTP
        // default of true.
        const body = encodePktStream([ENCODER.encode(`${OID_A} refs/heads/main\0ofs-delta\n`)]);
        const session = fakeSession({ body, servicePrologue: false });

        // Act
        const sut = await discoverRefsForService(session, 'git-upload-pack');

        // Assert
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.name).toBe('refs/heads/main');
      });
    });
  });
});

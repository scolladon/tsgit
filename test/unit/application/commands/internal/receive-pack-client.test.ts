/**
 * Unit tests for the receive-pack client helpers.
 *
 * Mirrors the upload-pack-client.test.ts contract:
 *  - discoverReceivePackRefs makes the right HTTP request.
 *  - selectPushCapabilities intersects + appends the agent slot.
 */
import { describe, expect, it } from 'vitest';
import type { GitServiceSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import {
  discoverReceivePackRefs,
  selectPushCapabilities,
} from '../../../../../src/application/commands/internal/receive-pack-client.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../../src/domain/protocol/pkt-line.js';

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

const asyncBytes = async function* (chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
};

const fakeSession = (body: Uint8Array): GitServiceSession => ({
  advertisement: (): Promise<AsyncIterable<PktLine>> =>
    Promise.resolve(decodePktStream(asyncBytes([body]))),
  exchange: () => Promise.reject(new Error('not implemented')),
  close: () => Promise.resolve(),
  servicePrologue: true,
});

describe('discoverReceivePackRefs', () => {
  describe('Given a 200 response with a valid receive-pack advertisement', () => {
    describe('When discoverReceivePackRefs runs', () => {
      it('Then the Advertisement is parsed', async () => {
        // Arrange
        const session = fakeSession(successAdvertisement());

        // Act
        const sut = await discoverReceivePackRefs(session);

        // Assert
        expect(sut.refs).toHaveLength(1);
        expect(sut.refs[0]?.name).toBe('refs/heads/main');
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

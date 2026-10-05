/**
 * Unit tests for the receive-pack client helpers.
 *
 * Mirrors the upload-pack-client.test.ts contract:
 *  - discoverReceivePackRefs makes the right HTTP request.
 *  - selectPushCapabilities requests what git's send-pack requests.
 */
import { describe, expect, it } from 'vitest';
import type { GitServiceSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import {
  discoverReceivePackRefs,
  selectPushCapabilities,
} from '../../../../../src/application/commands/internal/receive-pack-client.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
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
        const result = await discoverReceivePackRefs(session);

        // Assert
        expect(result.refs).toHaveLength(1);
        expect(result.refs[0]?.name).toBe('refs/heads/main');
      });
    });
  });
});

describe('selectPushCapabilities', () => {
  describe('Given an advertised set with only report-status', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then no agent is sent, as git sends one only to a server advertising its own', () => {
        // Arrange
        const sut = selectPushCapabilities;

        // Act
        const result = sut(['report-status'], 'sha1');

        // Assert
        expect(result).toEqual(['report-status']);
      });
    });
  });

  describe("Given git's own receive-pack advertisement", () => {
    describe('When selectPushCapabilities runs for an atomic push', () => {
      it("Then it requests exactly what git's send-pack does, in its order", () => {
        // Arrange
        const advertised = [
          'report-status',
          'report-status-v2',
          'delete-refs',
          'side-band-64k',
          'quiet',
          'atomic',
          'ofs-delta',
          'object-format=sha1',
          'agent=git/2.55.0',
        ];
        const sut = selectPushCapabilities;

        // Act
        const result = sut(advertised, 'sha1', ['atomic']);

        // Assert
        expect(result).toEqual([
          'report-status',
          'side-band-64k',
          'quiet',
          'atomic',
          'object-format=sha1',
          AGENT,
        ]);
      });
    });
  });

  describe('Given server advertises only %s', () => {
    describe('When selectPushCapabilities runs', () => {
      it.each([['report-status'], ['side-band-64k'], ['quiet']] as const)(
        'Then %s IS in the result',
        (cap) => {
          // Arrange & Act
          const result = selectPushCapabilities([cap], 'sha1');

          // Assert
          expect(result).toEqual([cap]);
        },
      );
    });
  });

  describe('Given the server advertises a capability that only steers the client', () => {
    describe('When selectPushCapabilities runs', () => {
      it.each([['ofs-delta'], ['delete-refs'], ['no-thin']] as const)(
        'Then %s is NOT in the result',
        (cap) => {
          // Arrange & Act
          const result = selectPushCapabilities([cap], 'sha1');

          // Assert
          expect(result).toEqual([]);
        },
      );
    });
  });

  describe('Given the server advertises its own agent string', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then the result has exactly one agent= entry (the client one)', () => {
        // Arrange & Act — the server's own agent is never echoed back.
        const result = selectPushCapabilities(['agent=git/2.x', 'report-status'], 'sha1');

        // Assert
        const agentEntries = result.filter((c) => c.startsWith('agent='));
        expect(agentEntries).toHaveLength(1);
        expect(agentEntries[0]).not.toBe('agent=git/2.x');
      });
    });
  });

  describe('Given the server advertises atomic and the push does not opt in', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then atomic is NOT in the result', () => {
        // Arrange & Act
        const result = selectPushCapabilities(['report-status', 'atomic'], 'sha1');

        // Assert
        expect(result).not.toContain('atomic');
      });
    });
  });

  describe('Given the server advertises atomic and the push opts in', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then atomic IS in the result', () => {
        // Arrange & Act
        const result = selectPushCapabilities(['report-status', 'atomic'], 'sha1', ['atomic']);

        // Assert
        expect(result).toContain('atomic');
      });
    });
  });

  describe('Given the server does NOT advertise atomic', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then atomic is NOT in the result', () => {
        // Arrange & Act — pins the negotiation contract: we only ask for what the
        // server can give us.
        const result = selectPushCapabilities(['report-status'], 'sha1', ['atomic']);

        // Assert
        expect(result).not.toContain('atomic');
      });
    });
  });

  describe('Given no opt-in and the server advertises push-cert=<nonce>', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then no push-cert token is in the result', () => {
        // Arrange & Act — kills the "always want push-cert" mutant.
        const result = selectPushCapabilities(['report-status', 'push-cert=abc123'], 'sha1');

        // Assert
        expect(result.some((c) => c === 'push-cert' || c.startsWith('push-cert='))).toBe(false);
      });
    });
  });

  describe('Given the push opts in to push-cert but the server does NOT advertise push-cert', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then no push-cert token is in the result', () => {
        // Arrange & Act — the intersect step still applies to push-cert.
        const result = selectPushCapabilities(['report-status'], 'sha1', ['push-cert']);

        // Assert
        expect(result.some((c) => c === 'push-cert' || c.startsWith('push-cert='))).toBe(false);
      });
    });
  });

  describe('Given a peer that never advertised object-format', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then the result omits object-format entirely', () => {
        // Arrange & Act — a pre-2.28 peer advertises no `object-format`, and
        // git gates its own token on `server_supports_hash()`. Sending one
        // regardless would put an unsolicited capability on every legacy
        // SHA-1 push.
        const result = selectPushCapabilities(['report-status'], 'sha1');

        // Assert
        expect(result.some((capability) => capability.startsWith('object-format='))).toBe(false);
      });
    });
  });

  describe('Given the local repository is sha1', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then the result carries object-format=sha1 when the peer advertised the capability', () => {
        // Arrange & Act — the peer must advertise `object-format` for git to
        // send one; the value sent is OURS, never the peer's echoed back.
        const result = selectPushCapabilities(['report-status', 'object-format=sha1'], 'sha1');

        // Assert
        expect(result).toContain('object-format=sha1');
      });
    });
  });

  describe('Given the local repository is sha256', () => {
    describe('When selectPushCapabilities runs', () => {
      it('Then the result carries object-format=sha256, our own, regardless of the server advert', () => {
        // Arrange & Act
        const result = selectPushCapabilities(['report-status', 'object-format=sha1'], 'sha256');

        // Assert
        expect(result).toContain('object-format=sha256');
        expect(result).not.toContain('object-format=sha1');
      });
    });
  });
});

/**
 * Unit tests for the shared `upload-pack-client` helpers. Pins behaviour
 * that the broader `fetch`/`clone` tests reach indirectly so Stryker can
 * see kills against each individual line.
 */
import { describe, expect, it } from 'vitest';
import type { GitServiceSession } from '../../../../../src/application/commands/internal/git-service-session.js';
import {
  advertisesFilter,
  discoverRefs,
  selectFetchCapabilities,
  uniqueRefOids,
} from '../../../../../src/application/commands/internal/upload-pack-client.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { ObjectId as OID } from '../../../../../src/domain/objects/index.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../../src/domain/protocol/pkt-line.js';

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

describe('discoverRefs', () => {
  describe('Given a 200 response carrying a valid advertisement', () => {
    describe('When discoverRefs runs', () => {
      it('Then the Advertisement is returned', async () => {
        // Arrange
        const session = fakeSession(successAdvertisement());

        // Act
        const result = await discoverRefs(session);

        // Assert
        expect(result.refs.length).toBe(1);
        expect(result.refs[0]?.name).toBe('refs/heads/main');
      });
    });
  });
});

describe('selectFetchCapabilities', () => {
  describe('Given an advertised set', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then the agent string is always appended', async () => {
        // Arrange & Act
        const result = selectFetchCapabilities(['side-band-64k'], 'sha1');

        // Assert — the AGENT slot is always sent regardless of server advert.
        expect(result.some((c) => c.startsWith('agent='))).toBe(true);
      });
    });
  });

  describe('Given the server advertises %s', () => {
    describe('When selectFetchCapabilities runs', () => {
      it.each([['thin-pack'], ['no-progress']] as const)(
        'Then it is NOT included in the result',
        async (cap) => {
          // Arrange & Act — kills each of the `c !== '<cap>'` mutants inside
          // the filter predicate.
          const result = selectFetchCapabilities([cap, 'side-band-64k'], 'sha1');

          // Assert
          expect(result).not.toContain(cap);
        },
      );
    });
  });

  describe('Given the server advertises multi_ack_detailed', () => {
    describe('When selecting fetch capabilities', () => {
      it('Then multi_ack_detailed is retained', async () => {
        // Arrange & Act
        const result = selectFetchCapabilities(
          ['multi_ack_detailed', 'side-band-64k', 'ofs-delta', 'thin-pack'],
          'sha1',
        );

        // Assert — retained (single-round strategy tolerates ACK ... common),
        // while thin-pack/no-progress stay filtered and AGENT is appended last.
        expect(result).toContain('multi_ack_detailed');
        expect(result).not.toContain('thin-pack');
        expect(result).not.toContain('no-progress');
        expect(result).toContain(AGENT);
      });
    });
  });

  describe('Given the server does NOT advertise side-band-64k', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then side-band-64k is NOT in the result', async () => {
        // Arrange & Act — kills the `.filter` → no-filter mutant; without the
        // intersect step, capabilities the server doesn't support would still
        // be sent.
        const result = selectFetchCapabilities([], 'sha1');

        // Assert
        expect(result).not.toContain('side-band-64k');
      });
    });
  });

  describe('Given the server advertises only side-band-64k', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then side-band-64k IS in the result', async () => {
        // Arrange & Act
        const result = selectFetchCapabilities(['side-band-64k'], 'sha1');

        // Assert
        expect(result).toContain('side-band-64k');
      });
    });
  });

  describe('Given the server advertises its own agent string', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then the agent slot is NOT duplicated', async () => {
        // Arrange — kills the `c !== AGENT` filter mutant on the last
        // conjunct. With the mutant, AGENT would survive the intersect step
        // and then get appended a SECOND time at the end of the function.
        const result = selectFetchCapabilities(['agent=git/2.x', 'side-band-64k'], 'sha1');

        // Assert — exactly one agent= entry, and it is the client's, not
        // the server's leaked echo.
        const agentEntries = result.filter((c) => c.startsWith('agent='));
        expect(agentEntries).toHaveLength(1);
        expect(agentEntries[0]).not.toBe('agent=git/2.x');
      });
    });
  });

  describe('Given the local repository is sha1', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then the result carries object-format=sha1 when the peer advertised the capability', () => {
        // Arrange & Act — the peer must advertise `object-format` for git to
        // send one; the value sent is OURS, never the peer's echoed back.
        const result = selectFetchCapabilities(['side-band-64k', 'object-format=sha1'], 'sha1');

        // Assert
        expect(result).toContain('object-format=sha1');
      });

      it('Then the result omits object-format entirely when the peer never advertised it', () => {
        // Arrange & Act — a pre-2.28 peer advertises no `object-format`, and
        // git gates its own token on `server_supports_hash()`. Sending one
        // regardless would put an unsolicited capability on every legacy
        // SHA-1 exchange.
        const result = selectFetchCapabilities(['side-band-64k'], 'sha1');

        // Assert
        expect(result.some((capability) => capability.startsWith('object-format='))).toBe(false);
      });
    });
  });

  describe('Given the local repository is sha256', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then the result carries object-format=sha256, our own, regardless of the server advert', () => {
        // Arrange & Act — the server's own object-format token (if any) is
        // dropped by the intersect step; we always send OUR OWN algorithm,
        // the same way AGENT is always appended verbatim.
        const result = selectFetchCapabilities(['object-format=sha1'], 'sha256');

        // Assert
        expect(result).toContain('object-format=sha256');
        expect(result).not.toContain('object-format=sha1');
      });
    });
  });
});

describe('advertisesFilter', () => {
  describe('Given a capability set', () => {
    describe('When advertisesFilter runs', () => {
      it.each([
        {
          capabilities: ['ofs-delta', 'filter', 'side-band-64k'],
          expected: true,
          label: 'a set including filter returns true',
        },
        {
          capabilities: ['ofs-delta', 'side-band-64k'],
          expected: false,
          label: 'a set without filter returns false',
        },
        { capabilities: [], expected: false, label: 'an empty set returns false' },
      ])('Then $label', ({ capabilities, expected }) => {
        // Arrange & Act
        const result = advertisesFilter(capabilities);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('uniqueRefOids', () => {
  describe('Given a list of refs', () => {
    describe('When uniqueRefOids runs', () => {
      it.each([
        {
          refs: [
            { name: 'refs/heads/main', id: OID_A },
            { name: 'refs/heads/release', id: OID_A },
            { name: 'refs/tags/v1', id: OID_B },
          ],
          // kills the `if (seen.has(r.id)) continue` mutant.
          expected: [OID_A, OID_B] as ObjectId[],
          label: 'two refs sharing the same oid: the oid appears once in the result',
        },
        { refs: [], expected: [], label: 'an empty refs list returns an empty array' },
        {
          refs: [
            { name: 'refs/heads/a', id: OID_B },
            { name: 'refs/heads/b', id: OID_A },
          ],
          expected: [OID_B, OID_A] as ObjectId[],
          label: 'refs with distinct oids preserve insertion order',
        },
      ])('Then $label', ({ refs, expected }) => {
        // Arrange + Act
        const result = uniqueRefOids(refs);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

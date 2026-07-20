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
        const sut = await discoverRefs(session);

        // Assert
        expect(sut.refs.length).toBe(1);
        expect(sut.refs[0]?.name).toBe('refs/heads/main');
      });
    });
  });
});

describe('selectFetchCapabilities', () => {
  describe('Given an advertised set', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then the agent string is always appended', async () => {
        // Arrange & Act
        const sut = selectFetchCapabilities(['side-band-64k']);

        // Assert — the AGENT slot is always sent regardless of server advert.
        expect(sut.some((c) => c.startsWith('agent='))).toBe(true);
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
          const sut = selectFetchCapabilities([cap, 'side-band-64k']);

          // Assert
          expect(sut).not.toContain(cap);
        },
      );
    });
  });

  describe('Given the server advertises multi_ack_detailed', () => {
    describe('When selecting fetch capabilities', () => {
      it('Then multi_ack_detailed is retained', async () => {
        // Arrange & Act
        const sut = selectFetchCapabilities([
          'multi_ack_detailed',
          'side-band-64k',
          'ofs-delta',
          'thin-pack',
        ]);

        // Assert — retained (single-round strategy tolerates ACK ... common),
        // while thin-pack/no-progress stay filtered and AGENT is appended last.
        expect(sut).toContain('multi_ack_detailed');
        expect(sut).not.toContain('thin-pack');
        expect(sut).not.toContain('no-progress');
        expect(sut[sut.length - 1]).toBe(AGENT);
      });
    });
  });

  describe('Given the server does NOT advertise side-band-64k', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then side-band-64k is NOT in the result', async () => {
        // Arrange & Act — kills the `.filter` → no-filter mutant; without the
        // intersect step, capabilities the server doesn't support would still
        // be sent.
        const sut = selectFetchCapabilities([]);

        // Assert
        expect(sut).not.toContain('side-band-64k');
      });
    });
  });

  describe('Given the server advertises only side-band-64k', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then side-band-64k IS in the result', async () => {
        // Arrange & Act
        const sut = selectFetchCapabilities(['side-band-64k']);

        // Assert
        expect(sut).toContain('side-band-64k');
      });
    });
  });

  describe('Given the server advertises its own agent string', () => {
    describe('When selectFetchCapabilities runs', () => {
      it('Then the agent slot is NOT duplicated', async () => {
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
  });
});

describe('advertisesFilter', () => {
  describe('Given a capability set including filter', () => {
    describe('When advertisesFilter runs', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const sut = advertisesFilter(['ofs-delta', 'filter', 'side-band-64k']);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a capability set without filter', () => {
    describe('When advertisesFilter runs', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const sut = advertisesFilter(['ofs-delta', 'side-band-64k']);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given an empty capability set', () => {
    describe('When advertisesFilter runs', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const sut = advertisesFilter([]);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('uniqueRefOids', () => {
  describe('Given two refs sharing the same oid', () => {
    describe('When uniqueRefOids runs', () => {
      it('Then the oid appears once in the result', async () => {
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
    });
  });

  describe('Given an empty refs list', () => {
    describe('When uniqueRefOids runs', () => {
      it('Then returns an empty array', async () => {
        // Arrange & Act
        const sut = uniqueRefOids([]);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given refs with distinct oids', () => {
    describe('When uniqueRefOids runs', () => {
      it('Then preserves insertion order', async () => {
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
  });
});

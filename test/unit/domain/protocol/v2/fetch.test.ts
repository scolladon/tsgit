import { describe, expect, it } from 'vitest';

import { ObjectId as OID } from '../../../../../src/domain/objects/object-id.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import {
  buildV2FetchRequest,
  parseV2FetchResponse,
} from '../../../../../src/domain/protocol/v2/fetch.js';

const ENCODER = new TextEncoder();
const bytesOf = (s: string): Uint8Array => ENCODER.encode(s);

const OID1 = OID.from('1'.repeat(40));
const OID2 = OID.from('2'.repeat(40));
const OID3 = OID.from('3'.repeat(40));
const OID4 = OID.from('4'.repeat(40));

const DELIM = bytesOf('0001');
const FLUSH = bytesOf('0000');

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function pktBytes(text: string): Uint8Array {
  const total = bytesOf(text).byteLength + 4;
  return bytesOf(total.toString(16).padStart(4, '0') + text);
}

async function* asyncOf(chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncOf([bytes]), { v2: true }));

const dataLine = (text: string): PktLine => ({ kind: 'data', payload: bytesOf(text) });

const responseStream = (bytes: Uint8Array): AsyncIterable<PktLine> =>
  decodePktStream(asyncOf([bytes]), { v2: true });

describe('buildV2FetchRequest', () => {
  describe('Given wants, haves, args, and done', () => {
    describe('When buildV2FetchRequest builds the request', () => {
      it('Then it emits command=fetch, delim, ofs-delta, include-tag, want lines, have lines, done, flush — and no thin-pack/no-progress', async () => {
        // Arrange
        const sut = buildV2FetchRequest;

        // Act
        const bytes = sut({
          wants: [OID1, OID2],
          haves: [OID3],
          args: ['ofs-delta', 'include-tag'],
          done: true,
        });
        const lines = await decodeAll(bytes);

        // Assert
        expect(lines).toEqual([
          dataLine('command=fetch\n'),
          dataLine(`${AGENT}\n`),
          dataLine('object-format=sha1\n'),
          { kind: 'delim' },
          dataLine('ofs-delta\n'),
          dataLine('include-tag\n'),
          dataLine(`want ${OID1}\n`),
          dataLine(`want ${OID2}\n`),
          dataLine(`have ${OID3}\n`),
          dataLine('done\n'),
          { kind: 'flush' },
        ]);
        expect(lines).not.toContainEqual(dataLine('thin-pack\n'));
        expect(lines).not.toContainEqual(dataLine('no-progress\n'));
      });
    });
  });

  describe('Given wants only, with haves, args, and done all omitted', () => {
    describe('When buildV2FetchRequest builds the request', () => {
      it('Then it emits only the command header, delim, want lines, and flush', async () => {
        // Arrange
        const sut = buildV2FetchRequest;

        // Act
        const bytes = sut({ wants: [OID1], haves: [] });
        const lines = await decodeAll(bytes);

        // Assert
        expect(lines).toEqual([
          dataLine('command=fetch\n'),
          dataLine(`${AGENT}\n`),
          dataLine('object-format=sha1\n'),
          { kind: 'delim' },
          dataLine(`want ${OID1}\n`),
          { kind: 'flush' },
        ]);
      });
    });
  });
});

describe('parseV2FetchResponse', () => {
  describe('Given a response with an acknowledgments section then a packfile section', () => {
    describe('When parseV2FetchResponse parses it', () => {
      it('Then acks/ready are populated and packBody yields the pack bytes', async () => {
        // Arrange
        const stream = responseStream(
          concatBytes(
            pktBytes('acknowledgments\n'),
            pktBytes(`ACK ${OID1}\n`),
            pktBytes('ready\n'),
            DELIM,
            pktBytes('packfile\n'),
            pktBytes('\x01PACK-DATA'),
            FLUSH,
          ),
        );

        // Act
        const sut = await parseV2FetchResponse(stream);
        const packChunks = await collect(sut.packBody);

        // Assert
        expect(sut.acks).toEqual([{ id: OID1, status: 'ack' }]);
        expect(sut.ready).toBe(true);
        expect(sut.nak).toBe(false);
        expect(packChunks).toEqual([bytesOf('PACK-DATA')]);
      });
    });
  });

  describe('Given a post-"done" response that opens directly with a packfile section', () => {
    describe('When parsed', () => {
      it('Then packBody yields the pack and acks is empty', async () => {
        // Arrange
        const stream = responseStream(
          concatBytes(pktBytes('packfile\n'), pktBytes('\x01PACK-DATA'), FLUSH),
        );

        // Act
        const sut = await parseV2FetchResponse(stream);
        const packChunks = await collect(sut.packBody);

        // Assert
        expect(sut.acks).toEqual([]);
        expect(sut.ready).toBe(false);
        expect(packChunks).toEqual([bytesOf('PACK-DATA')]);
      });
    });
  });

  describe('Given a response carrying a shallow-info section', () => {
    describe('When parsed', () => {
      it('Then shallow and unshallow oids are captured', async () => {
        // Arrange
        const stream = responseStream(
          concatBytes(
            pktBytes('shallow-info\n'),
            pktBytes(`shallow ${OID1}\n`),
            pktBytes(`unshallow ${OID2}\n`),
            DELIM,
            pktBytes('packfile\n'),
            pktBytes('\x01PACK-DATA'),
            FLUSH,
          ),
        );

        // Act
        const sut = await parseV2FetchResponse(stream);

        // Assert
        expect(sut.shallow).toEqual([OID1]);
        expect(sut.unshallow).toEqual([OID2]);
      });
    });
  });

  describe('Given a response carrying a NAK in acknowledgments', () => {
    describe('When parsed', () => {
      it('Then nak is true and ready is false', async () => {
        // Arrange
        const stream = responseStream(
          concatBytes(pktBytes('acknowledgments\n'), pktBytes('NAK\n'), FLUSH),
        );

        // Act
        const sut = await parseV2FetchResponse(stream);
        const packChunks = await collect(sut.packBody);

        // Assert
        expect(sut.nak).toBe(true);
        expect(sut.ready).toBe(false);
        expect(packChunks).toEqual([]);
      });
    });
  });

  describe('Given a response carrying a wanted-refs section', () => {
    describe('When parsed', () => {
      it('Then wantedRefs captures the oid/name pairs', async () => {
        // Arrange
        const stream = responseStream(
          concatBytes(
            pktBytes('wanted-refs\n'),
            pktBytes(`${OID3} refs/heads/main\n`),
            pktBytes(`${OID4} refs/heads/feature\n`),
            DELIM,
            pktBytes('packfile\n'),
            pktBytes('\x01PACK-DATA'),
            FLUSH,
          ),
        );

        // Act
        const sut = await parseV2FetchResponse(stream);

        // Assert
        expect(sut.wantedRefs).toEqual([
          { id: OID3, name: 'refs/heads/main' },
          { id: OID4, name: 'refs/heads/feature' },
        ]);
      });
    });
  });
});

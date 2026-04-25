import { describe, expect, it } from 'vitest';

import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { decodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import {
  parseAdvertisedRefs,
  parseUploadPackResponse,
} from '../../../../src/domain/protocol/upload-pack.js';
import {
  buildDiscoveryBody,
  buildUploadPackResponseBody,
} from '../../../fixtures/transport/builders.js';

const OID1 = 'a'.repeat(40);
const OID2 = 'b'.repeat(40);
const OID3 = 'c'.repeat(40);

async function* asyncBytes(parts: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const p of source) out.push(p);
  return out;
}

describe('upload-pack integration — discovery', () => {
  it('Given a discovery body with HEAD + refs/heads/main + a peeled tag, When parsed end-to-end, Then capabilities, refs, and head match', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['multi_ack_detailed', 'side-band-64k', 'symref=HEAD:refs/heads/main'],
      refs: [
        { name: 'HEAD', id: OID1 },
        { name: 'refs/heads/main', id: OID1 },
        { name: 'refs/tags/v1', id: OID2, peeled: OID3 },
      ],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.capabilities).toEqual([
      'multi_ack_detailed',
      'side-band-64k',
      'symref=HEAD:refs/heads/main',
    ]);
    expect(sut.refs).toHaveLength(3);
    const tag = sut.refs.find((r) => r.name === 'refs/tags/v1');
    expect(tag?.peeled).toBe(ObjectId.from(OID3));
    expect(sut.head?.name).toBe('HEAD');
    expect(sut.head?.id).toBe(ObjectId.from(OID1));
  });
});

describe('upload-pack integration — clone response', () => {
  it('Given a single-round clone response with packBytes, When parsed end-to-end, Then nak true and packBody matches packBytes byte-for-byte', async () => {
    // Arrange
    const packBytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 0x02, 0xff, 0xee, 0xdd]);
    const body = buildUploadPackResponseBody({
      packBytes,
      sideBand: true,
    });

    // Act
    const result = await parseUploadPackResponse(decodePktStream(asyncBytes([body])), {
      sideBand: true,
    });
    const collected = await collect(result.packBody);

    // Assert
    expect(result.nak).toBe(true);
    expect(result.acks).toEqual([]);
    const total = new Uint8Array(packBytes.byteLength);
    let off = 0;
    for (const c of collected) {
      total.set(c, off);
      off += c.byteLength;
    }
    expect(total).toEqual(packBytes);
  });

  it('Given a multi-round response with acks, When parsed, Then acks deep-equals input', async () => {
    // Arrange
    const body = buildUploadPackResponseBody({
      acks: [
        { id: OID1, status: 'continue' },
        { id: OID2, status: 'ack' },
      ],
      packBytes: new Uint8Array([0x50, 0x41, 0x43, 0x4b]),
      sideBand: true,
    });

    // Act
    const result = await parseUploadPackResponse(decodePktStream(asyncBytes([body])), {
      sideBand: true,
    });
    await collect(result.packBody);

    // Assert
    expect(result.acks).toEqual([
      { id: ObjectId.from(OID1), status: 'continue' },
      { id: ObjectId.from(OID2), status: 'ack' },
    ]);
  });
});

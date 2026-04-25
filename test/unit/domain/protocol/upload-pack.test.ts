import { describe, expect, it, vi } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { ObjectId as OID } from '../../../../src/domain/objects/object-id.js';
import {
  decodePktStream,
  encodePktStream,
  type PktLine,
} from '../../../../src/domain/protocol/pkt-line.js';
import {
  buildDiscoveryUrl,
  buildUploadPackRequest,
  parseAdvertisedRefs,
  parseUploadPackResponse,
} from '../../../../src/domain/protocol/upload-pack.js';

const enc = new TextEncoder();
const bytesOf = (s: string): Uint8Array => enc.encode(s);
const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

const OID1 = OID.from('a'.repeat(40));
const OID2 = OID.from('b'.repeat(40));
const OID3 = OID.from('c'.repeat(40));

async function* asyncOf<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function* asyncBytes(parts: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
}

interface BuildDiscoveryInput {
  readonly service: 'git-upload-pack' | 'git-receive-pack';
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<{
    readonly name: string;
    readonly id: ObjectId;
    readonly peeled?: ObjectId;
  }>;
}

const buildDiscoveryBody = (d: BuildDiscoveryInput): Uint8Array => {
  const NUL = '\0';
  const headerStream = encodePktStream([bytesOf(`# service=${d.service}\n`)]);
  const refLines: Uint8Array[] = [];
  d.refs.forEach((r, idx) => {
    if (idx === 0) {
      refLines.push(bytesOf(`${r.id} ${r.name}${NUL}${d.capabilities.join(' ')}\n`));
    } else {
      refLines.push(bytesOf(`${r.id} ${r.name}\n`));
    }
    if (r.peeled !== undefined) {
      refLines.push(bytesOf(`${r.peeled} ${r.name}^{}\n`));
    }
  });
  const refStream = encodePktStream(refLines);
  return concat(headerStream, refStream);
};

describe('buildDiscoveryUrl', () => {
  it('Given a base URL and service, When buildDiscoveryUrl, Then appends /info/refs?service=...', () => {
    // Arrange & Act
    const sut = buildDiscoveryUrl('https://example.com/repo.git', 'git-upload-pack');

    // Assert
    expect(sut).toBe('https://example.com/repo.git/info/refs?service=git-upload-pack');
  });

  it('Given a trailing slash, When buildDiscoveryUrl, Then no double slash', () => {
    expect(buildDiscoveryUrl('https://example.com/repo.git/', 'git-upload-pack')).toBe(
      'https://example.com/repo.git/info/refs?service=git-upload-pack',
    );
  });

  it('Given a pre-existing query string, When buildDiscoveryUrl, Then appends with &', () => {
    expect(buildDiscoveryUrl('https://example.com/repo.git?token=xyz', 'git-upload-pack')).toBe(
      'https://example.com/repo.git/info/refs?token=xyz&service=git-upload-pack',
    );
  });

  it('Given a fragment, When buildDiscoveryUrl, Then throws INVALID_BASE_URL with reason "fragment must not be set"', () => {
    try {
      buildDiscoveryUrl('https://example.com/repo.git#frag', 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'INVALID_BASE_URL', reason: 'fragment must not be set' });
    }
  });

  it('Given an invalid URL, When buildDiscoveryUrl, Then throws INVALID_BASE_URL with reason "invalid URL"', () => {
    try {
      buildDiscoveryUrl('not-a-url', 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'INVALID_BASE_URL', reason: 'invalid URL' });
    }
  });

  it('Given an ftp:// scheme, When buildDiscoveryUrl, Then returns the URL (scheme validated at adapter layer)', () => {
    expect(buildDiscoveryUrl('ftp://example.com/repo', 'git-upload-pack')).toBe(
      'ftp://example.com/repo/info/refs?service=git-upload-pack',
    );
  });

  it('Given a URL with no .git suffix, When buildDiscoveryUrl, Then no auto-append', () => {
    expect(buildDiscoveryUrl('https://example.com/repo', 'git-upload-pack')).toBe(
      'https://example.com/repo/info/refs?service=git-upload-pack',
    );
  });
});

describe('parseAdvertisedRefs — edge cases', () => {
  it('Given an empty stream, When parsed, Then throws MISSING_SERVICE_HEADER', async () => {
    // Arrange — empty source ends before any data packet.
    const empty: AsyncIterable<Uint8Array> = (async function* () {
      // yield nothing
    })();

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(empty), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('MISSING_SERVICE_HEADER');
    }
  });

  it('Given a service header followed by a non-flush data packet (no separator), When parsed, Then throws MISSING_SERVICE_HEADER', async () => {
    // Arrange — service header pkt + another data pkt instead of flush
    const headerStream = encodePktStream([
      bytesOf('# service=git-upload-pack\n'),
      bytesOf(`${OID1} refs/heads/main\0caps\n`),
    ]);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([headerStream])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('MISSING_SERVICE_HEADER');
    }
  });

  it('Given a service header without a trailing flush, When parsed, Then throws MISSING_SERVICE_HEADER', async () => {
    // Arrange — only the service line, no flush after
    const body = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const trimmed = body.subarray(0, body.byteLength - 4);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([trimmed])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('MISSING_SERVICE_HEADER');
    }
  });
});

describe('parseAdvertisedRefs — happy path', () => {
  it('Given a discovery body with two refs and HEAD, When parsed, Then capabilities and refs deep-equal', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['multi_ack_detailed', 'side-band-64k'],
      refs: [
        { name: 'HEAD', id: OID1 },
        { name: 'refs/heads/main', id: OID1 },
      ],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.capabilities).toEqual(['multi_ack_detailed', 'side-band-64k']);
    expect(sut.refs).toHaveLength(2);
    expect(sut.head?.name).toBe('HEAD');
    expect(sut.head?.id).toBe(OID1);
  });
});

describe('parseAdvertisedRefs — service header validation', () => {
  it('Given a stream advertising the wrong service, When parsed with expected upload-pack, Then throws MISSING_SERVICE_HEADER', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-receive-pack',
      capabilities: ['multi_ack_detailed'],
      refs: [{ name: 'refs/heads/main', id: OID1 }],
    });

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({
        code: 'MISSING_SERVICE_HEADER',
        expected: 'git-upload-pack',
        actual: 'git-receive-pack',
      });
    }
  });

  it('Given a stream WITHOUT a "# service=" header, When parsed, Then throws MISSING_SERVICE_HEADER', async () => {
    // Arrange — first packet is a ref line, not "# service="
    const body = encodePktStream([bytesOf(`${OID1} refs/heads/main\0multi_ack\n`)]);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('MISSING_SERVICE_HEADER');
    }
  });
});

describe('parseAdvertisedRefs — capability extraction', () => {
  it('Given the first ref payload without NUL, When parsed, Then throws MISSING_CAPABILITIES', async () => {
    // Arrange
    const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const refStream = encodePktStream([bytesOf(`${OID1} refs/heads/main\n`)]);
    const body = concat(headerStream, refStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('MISSING_CAPABILITIES');
    }
  });
});

describe('parseAdvertisedRefs — ref validation', () => {
  it('Given a ref line with no name, When parsed, Then throws INVALID_REF_LINE', async () => {
    // Arrange
    const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const refStream = encodePktStream([bytesOf(`${OID1}\0caps\n`)]);
    const body = concat(headerStream, refStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('INVALID_REF_LINE');
    }
  });

  it('Given a ref line with not-a-sha id, When parsed, Then throws INVALID_REF_LINE', async () => {
    // Arrange
    const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const refStream = encodePktStream([bytesOf('not-a-sha refs/heads/main\0caps\n')]);
    const body = concat(headerStream, refStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('INVALID_REF_LINE');
    }
  });

  it('Given two ref lines with the same name, When parsed, Then throws DUPLICATE_REF', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['caps'],
      refs: [
        { name: 'refs/heads/main', id: OID1 },
        { name: 'refs/heads/main', id: OID2 },
      ],
    });

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'DUPLICATE_REF', name: 'refs/heads/main' });
    }
  });
});

describe('parseAdvertisedRefs — empty advertisement', () => {
  it('Given a discovery body with header + flush + flush (no refs at all), When parsed, Then capabilities=[] and refs=[]', async () => {
    // Arrange — service header + ref-section with no entries
    const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const refStream = encodePktStream([]); // just a trailing flush
    const body = concat(headerStream, refStream);

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.capabilities).toEqual([]);
    expect(sut.refs).toEqual([]);
  });
});

describe('parseAdvertisedRefs — additional ref validation', () => {
  it('Given a first ref line with a trailing space before NUL (empty name), When parsed, Then throws INVALID_REF_LINE', async () => {
    // Arrange — "<sha> \0caps\n" → name segment is empty
    const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const refStream = encodePktStream([bytesOf(`${OID1} \0caps\n`)]);
    const body = concat(headerStream, refStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('INVALID_REF_LINE');
    }
  });

  it('Given a subsequent ref line with no space, When parsed, Then throws INVALID_REF_LINE', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['caps'],
      refs: [{ name: 'refs/heads/main', id: OID1 }],
    });
    // Append a malformed ref line via raw pkt-line.
    const extraStream = encodePktStream([bytesOf(`${OID2}\n`)]);
    const fullBody = concat(body.subarray(0, body.byteLength - 4), extraStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([fullBody])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('INVALID_REF_LINE');
    }
  });

  it('Given a subsequent ref line with trailing space and empty name, When parsed, Then throws INVALID_REF_LINE', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['caps'],
      refs: [{ name: 'refs/heads/main', id: OID1 }],
    });
    const extraStream = encodePktStream([bytesOf(`${OID2} \n`)]);
    const fullBody = concat(body.subarray(0, body.byteLength - 4), extraStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([fullBody])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('INVALID_REF_LINE');
    }
  });

  it('Given a peeled tag whose base ref is missing, When parsed, Then throws INVALID_REF_LINE', async () => {
    // Arrange
    const headerStream = encodePktStream([bytesOf('# service=git-upload-pack\n')]);
    const refStream = encodePktStream([
      bytesOf(`${OID1} refs/heads/main\0caps\n`),
      bytesOf(`${OID2} refs/tags/missing^{}\n`),
    ]);
    const body = concat(headerStream, refStream);

    // Act & Assert
    try {
      await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('INVALID_REF_LINE');
    }
  });
});

describe('parseAdvertisedRefs — peeled tags', () => {
  it('Given a tag with peeled commit, When parsed, Then ref entry has peeled === commit oid', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['caps'],
      refs: [{ name: 'refs/tags/v1', id: OID2, peeled: OID3 }],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.refs).toHaveLength(1);
    expect(sut.refs[0]?.name).toBe('refs/tags/v1');
    expect(sut.refs[0]?.id).toBe(OID2);
    expect(sut.refs[0]?.peeled).toBe(OID3);
  });
});

describe('parseAdvertisedRefs — symref HEAD without direct HEAD ref', () => {
  it('Given symref pointing to an existing target ref but no HEAD ref, When parsed, Then head.name === "HEAD" with target id', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['symref=HEAD:refs/heads/main'],
      refs: [{ name: 'refs/heads/main', id: OID1 }],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.head?.name).toBe('HEAD');
    expect(sut.head?.id).toBe(OID1);
  });

  it('Given symref pointing to a non-existent target, When parsed, Then head is undefined', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['symref=HEAD:refs/heads/missing'],
      refs: [{ name: 'refs/heads/main', id: OID1 }],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.head).toBeUndefined();
  });

  it('Given no symref capability and no HEAD ref, When parsed, Then head is undefined', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['multi_ack_detailed'],
      refs: [{ name: 'refs/heads/main', id: OID1 }],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.head).toBeUndefined();
  });
});

describe('parseAdvertisedRefs — symref HEAD with direct HEAD ref', () => {
  it('Given symref capability and a HEAD ref, When parsed, Then head is exposed with name "HEAD"', async () => {
    // Arrange
    const body = buildDiscoveryBody({
      service: 'git-upload-pack',
      capabilities: ['multi_ack_detailed', 'symref=HEAD:refs/heads/main'],
      refs: [
        { name: 'HEAD', id: OID1 },
        { name: 'refs/heads/main', id: OID1 },
      ],
    });

    // Act
    const sut = await parseAdvertisedRefs(decodePktStream(asyncBytes([body])), 'git-upload-pack');

    // Assert
    expect(sut.head?.name).toBe('HEAD');
    expect(sut.refs.find((r) => r.name === 'refs/heads/main')).toBeDefined();
  });
});

describe('buildUploadPackRequest', () => {
  const decodeAll = async (bytes: Uint8Array): Promise<PktLine[]> =>
    collect(decodePktStream(asyncBytes([bytes])));

  it('Given wants and done=true, When built, Then bytes contain "want <oid> caps" + flush + "done"', async () => {
    // Arrange & Act
    const sut = buildUploadPackRequest({
      wants: [OID1],
      haves: [],
      capabilities: ['multi_ack_detailed', 'side-band-64k'],
      done: true,
    });
    const lines = await decodeAll(sut);

    // Assert
    expect(lines).toHaveLength(3);
    expect(lines[0]?.kind).toBe('data');
    if (lines[0]?.kind === 'data') {
      expect(new TextDecoder().decode(lines[0].payload)).toBe(
        `want ${OID1} multi_ack_detailed side-band-64k\n`,
      );
    }
    expect(lines[1]).toEqual({ kind: 'flush' });
    expect(lines[2]?.kind).toBe('data');
    if (lines[2]?.kind === 'data') {
      expect(new TextDecoder().decode(lines[2].payload)).toBe('done\n');
    }
  });

  it('Given two wants, When built, Then capabilities appear only on the first want line', async () => {
    // Arrange & Act
    const sut = buildUploadPackRequest({
      wants: [OID1, OID2],
      haves: [],
      capabilities: ['side-band-64k'],
      done: true,
    });
    const lines = await decodeAll(sut);

    // Assert
    const dataLines = lines.filter(
      (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
    );
    const dec = new TextDecoder();
    expect(dec.decode(dataLines[0]?.payload)).toBe(`want ${OID1} side-band-64k\n`);
    expect(dec.decode(dataLines[1]?.payload)).toBe(`want ${OID2}\n`);
  });

  it('Given haves and no done, When built, Then bytes include have lines and a trailing flush (multi-round)', async () => {
    // Arrange & Act
    const sut = buildUploadPackRequest({
      wants: [OID1],
      haves: [OID2, OID3],
      capabilities: ['side-band-64k'],
    });
    const lines = await decodeAll(sut);

    // Assert — kinds in order: data(want), flush, data(have), data(have), flush
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(['data', 'flush', 'data', 'data', 'flush']);
    const dec = new TextDecoder();
    const dataLines = lines.filter(
      (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
    );
    expect(dec.decode(dataLines[1]?.payload)).toBe(`have ${OID2}\n`);
    expect(dec.decode(dataLines[2]?.payload)).toBe(`have ${OID3}\n`);
  });

  it('Given depth, When built, Then includes "deepen <n>" line before the flush', async () => {
    // Arrange & Act
    const sut = buildUploadPackRequest({
      wants: [OID1],
      haves: [],
      capabilities: [],
      depth: 5,
    });
    const lines = await decodeAll(sut);

    // Assert
    const dec = new TextDecoder();
    const dataLines = lines.filter(
      (l): l is { kind: 'data'; payload: Uint8Array } => l.kind === 'data',
    );
    expect(dec.decode(dataLines[1]?.payload)).toBe('deepen 5\n');
  });

  it('Given empty wants, When built, Then throws EMPTY_WANTS', () => {
    try {
      buildUploadPackRequest({ wants: [], haves: [], capabilities: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data.code).toBe('EMPTY_WANTS');
    }
  });
});

describe('parseUploadPackResponse', () => {
  const sideBandPkt = (channel: number, body: Uint8Array): PktLine => {
    const payload = new Uint8Array(body.byteLength + 1);
    payload[0] = channel;
    payload.set(body, 1);
    return { kind: 'data', payload };
  };
  const dataPkt = (s: string): PktLine => ({ kind: 'data', payload: bytesOf(s) });

  it('Given NAK followed by sideband channel-1 packets and flush, When parsed (sideBand:true), Then nak true and packBody yields N bytes', async () => {
    // Arrange
    const packBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const source = asyncOf<PktLine>([
      dataPkt('NAK\n'),
      sideBandPkt(1, packBytes),
      { kind: 'flush' },
    ]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: true });
    const collected = await collect(result.packBody);

    // Assert
    expect(result.nak).toBe(true);
    expect(result.acks).toEqual([]);
    const total = collected.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(packBytes.byteLength);
  });

  it('Given ACK lines + NAK + sideband pack + flush, When parsed (sideBand:true), Then acks deep-equals expected statuses', async () => {
    // Arrange
    const packBytes = new Uint8Array([0xff]);
    const source = asyncOf<PktLine>([
      dataPkt(`ACK ${OID1} continue\n`),
      dataPkt(`ACK ${OID2}\n`),
      dataPkt('NAK\n'),
      sideBandPkt(1, packBytes),
      { kind: 'flush' },
    ]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: true });
    await collect(result.packBody);

    // Assert
    expect(result.acks).toEqual([
      { id: OID1, status: 'continue' },
      { id: OID2, status: 'ack' },
    ]);
    expect(result.nak).toBe(true);
  });

  it.each([
    'common',
    'ready',
  ] as const)('Given an ACK line with status %s, When parsed, Then acks contains the matching status entry', async (status) => {
    // Arrange
    const source = asyncOf<PktLine>([
      dataPkt(`ACK ${OID1} ${status}\n`),
      dataPkt('NAK\n'),
      { kind: 'flush' },
    ]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: false });

    // Assert
    expect(result.acks).toEqual([{ id: OID1, status }]);
  });

  it('Given an unknown ACK status, When parsed, Then rejects with UNKNOWN_ACK_STATUS', async () => {
    // Arrange
    const source = asyncOf<PktLine>([dataPkt(`ACK ${OID1} bogus\n`)]);

    // Act & Assert
    try {
      await parseUploadPackResponse(source, { sideBand: true });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      const te = err as TsgitError;
      expect(te.data).toEqual({ code: 'UNKNOWN_ACK_STATUS', value: 'bogus' });
    }
  });

  it('Given sideBand:false with raw pack packets, When parsed, Then packBody yields raw payloads', async () => {
    // Arrange
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const source = asyncOf<PktLine>([
      dataPkt('NAK\n'),
      { kind: 'data', payload: a },
      { kind: 'data', payload: b },
      { kind: 'flush' },
    ]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: false });
    const collected = await collect(result.packBody);

    // Assert
    expect(result.nak).toBe(true);
    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual(a);
    expect(collected[1]).toEqual(b);
  });

  it('Given a channel-2 packet, When parsed (sideBand:true) with onProgress, Then onProgress called once with the text', async () => {
    // Arrange
    const onProgress = vi.fn<(text: string) => void>();
    const source = asyncOf<PktLine>([
      dataPkt('NAK\n'),
      sideBandPkt(2, bytesOf('Counting objects: 5\n')),
      { kind: 'flush' },
    ]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: true, onProgress });
    await collect(result.packBody);

    // Assert
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('Counting objects: 5\n');
  });

  it('Given an empty source, When parsed (sideBand:false), Then nak false, acks empty, packBody is empty', async () => {
    // Arrange
    const empty: AsyncIterable<PktLine> = (async function* () {
      // yield nothing
    })();

    // Act
    const result = await parseUploadPackResponse(empty, { sideBand: false });
    const collected = await collect(result.packBody);

    // Assert
    expect(result.nak).toBe(false);
    expect(result.acks).toEqual([]);
    expect(collected).toEqual([]);
  });

  it('Given an ACK packet without a trailing newline, When parsed, Then acks captured (defensive stripTrailingNewline branch)', async () => {
    // Arrange — payload without trailing \n exercises the false branch of stripTrailingNewline
    const ackNoNewline: PktLine = {
      kind: 'data',
      payload: bytesOf(`ACK ${OID1}`),
    };
    const source = asyncOf<PktLine>([ackNoNewline, dataPkt('NAK\n'), { kind: 'flush' }]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: false });
    await collect(result.packBody);

    // Assert
    expect(result.nak).toBe(true);
    expect(result.acks).toEqual([{ id: OID1, status: 'ack' }]);
  });

  it('Given a flush as the first packet (no meta), When parsed (sideBand:false), Then packBody yields nothing and acks empty', async () => {
    // Arrange — flush before any meta data; splitMeta returns immediately
    const source = asyncOf<PktLine>([{ kind: 'flush' }]);

    // Act
    const result = await parseUploadPackResponse(source, { sideBand: false });
    const collected = await collect(result.packBody);

    // Assert
    expect(result.nak).toBe(false);
    expect(result.acks).toEqual([]);
    expect(collected).toEqual([]);
  });
});

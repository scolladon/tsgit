import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decodePktStream,
  encodePktLine,
  encodePktStream,
  type PktLine,
} from '../../../../src/domain/protocol/pkt-line.js';

async function* asyncOf(parts: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

async function collect(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const out: PktLine[] = [];
  for await (const p of source) out.push(p);
  return out;
}

const splitBytes = (buf: Uint8Array, sizes: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= buf.byteLength) break;
    const end = Math.min(offset + size, buf.byteLength);
    chunks.push(buf.slice(offset, end));
    offset = end;
  }
  if (offset < buf.byteLength) chunks.push(buf.slice(offset));
  return chunks;
};

describe('pkt-line laws', () => {
  it('Property: encodePktLine then decodePktStream round-trips for any payload up to MAX_PKT_LINE_PAYLOAD', async () => {
    // Arrange
    // Assert
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 65516 }), async (payloadArr) => {
        const payload = Uint8Array.from(payloadArr);
        const encoded = encodePktLine(payload);
        const decoded = await collect(decodePktStream(asyncOf([encoded])));
        expect(decoded).toEqual([{ kind: 'data', payload }]);
      }),
      { numRuns: 200 },
    );
  });

  it('Property: encodePktStream then decode produces N data entries plus a trailing flush', async () => {
    // Arrange
    // Assert
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 0, maxLength: 1024 }), { maxLength: 50 }),
        async (rawPayloads) => {
          const payloads = rawPayloads.map((p) => Uint8Array.from(p));
          const encoded = encodePktStream(payloads);
          const decoded = await collect(decodePktStream(asyncOf([encoded])));
          expect(decoded.length).toBe(payloads.length + 1);
          payloads.forEach((p, i) => {
            expect(decoded[i]).toEqual({ kind: 'data', payload: p });
          });
          expect(decoded[payloads.length]).toEqual({ kind: 'flush' });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property: chunk re-arrangement is invariant for valid encoded streams', async () => {
    // Arrange
    // Assert
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 0, maxLength: 256 }), { maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 64 }), { maxLength: 16 }),
        async (rawPayloads, sizes) => {
          const payloads = rawPayloads.map((p) => Uint8Array.from(p));
          const encoded = encodePktStream(payloads);
          const oneChunk = await collect(decodePktStream(asyncOf([encoded])));
          const splitChunks = await collect(decodePktStream(asyncOf(splitBytes(encoded, sizes))));
          expect(splitChunks).toEqual(oneChunk);
        },
      ),
      { numRuns: 100 },
    );
  });
});

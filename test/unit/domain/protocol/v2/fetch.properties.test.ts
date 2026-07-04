import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import { buildV2FetchRequest } from '../../../../../src/domain/protocol/v2/fetch.js';
import { doneArb, havesArb, wantsArb } from '../arbitraries.js';
import { argsArb } from './arbitraries.js';

const ROUND_TRIP_RUNS = 100;
const ENCODER = new TextEncoder();
const bytesOf = (s: string): Uint8Array => ENCODER.encode(s);

async function* asyncOf<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncOf([bytes]), { v2: true }));

describe('Given arbitrary wants, haves, args, and done', () => {
  describe('When buildV2FetchRequest builds the request and the bytes are decoded', () => {
    it('Then it always yields command=fetch, delim, arg-lines, want lines, have lines, done iff requested, and flush', async () => {
      // Arrange
      const sut = buildV2FetchRequest;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(
          wantsArb(),
          havesArb(),
          argsArb(),
          doneArb(),
          async (wants, haves, args, done) => {
            const bytes = sut({ wants, haves, args, done });
            const lines = await decodeAll(bytes);

            expect(lines[0]).toEqual({ kind: 'data', payload: bytesOf('command=fetch\n') });
            expect(lines[1]).toEqual({ kind: 'data', payload: bytesOf(`${AGENT}\n`) });
            expect(lines[2]).toEqual({ kind: 'data', payload: bytesOf('object-format=sha1\n') });
            expect(lines[3]).toEqual({ kind: 'delim' });

            let idx = 4;
            for (const arg of args) {
              expect(lines[idx]).toEqual({ kind: 'data', payload: bytesOf(`${arg}\n`) });
              idx += 1;
            }
            for (const want of wants) {
              expect(lines[idx]).toEqual({ kind: 'data', payload: bytesOf(`want ${want}\n`) });
              idx += 1;
            }
            for (const have of haves) {
              expect(lines[idx]).toEqual({ kind: 'data', payload: bytesOf(`have ${have}\n`) });
              idx += 1;
            }
            if (done) {
              expect(lines[idx]).toEqual({ kind: 'data', payload: bytesOf('done\n') });
              idx += 1;
            }
            expect(lines).toHaveLength(idx + 1);
            expect(lines.at(-1)).toEqual({ kind: 'flush' });
          },
        ),
        { numRuns: ROUND_TRIP_RUNS },
      );
    });
  });
});

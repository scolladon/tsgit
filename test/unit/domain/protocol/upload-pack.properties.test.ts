import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodePktStream, type PktLine } from '../../../../src/domain/protocol/pkt-line.js';
import { buildUploadPackRequest } from '../../../../src/domain/protocol/upload-pack.js';
import { doneArb, havesArb, wantsArb } from './arbitraries.js';

const RUNS = 100;
const DECODER = new TextDecoder();

async function* asyncBytes(chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

async function collect(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const out: PktLine[] = [];
  for await (const pkt of source) out.push(pkt);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncBytes([bytes])));

describe('Given an arbitrary want/have/done request', () => {
  describe('When built and decoded', () => {
    it('Then the have-list is terminated by a flush iff done is false and by "done" iff done is true — never both', async () => {
      // Arrange
      const sut = buildUploadPackRequest;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(wantsArb(), havesArb(), doneArb(), async (wants, haves, done) => {
          const bytes = sut({ wants, haves, capabilities: [], done });
          const lines = await decodeAll(bytes);

          // The want-list is followed by exactly one flush.
          const wantFlushIdx = wants.length;
          for (let i = 0; i < wantFlushIdx; i += 1) {
            expect(lines[i]?.kind).toBe('data');
          }
          expect(lines[wantFlushIdx]).toEqual({ kind: 'flush' });

          if (haves.length === 0) {
            const expectedTotal = wants.length + 1 + (done ? 1 : 0);
            expect(lines).toHaveLength(expectedTotal);
            return;
          }

          const haveStart = wantFlushIdx + 1;
          const haveEnd = haveStart + haves.length; // exclusive of the terminator frame
          for (let i = haveStart; i < haveEnd; i += 1) {
            expect(lines[i]?.kind).toBe('data');
          }
          const terminator = lines[haveEnd];
          expect(lines).toHaveLength(haveEnd + 1);
          if (done) {
            expect(terminator?.kind).toBe('data');
            if (terminator?.kind === 'data') {
              expect(DECODER.decode(terminator.payload)).toBe('done\n');
            }
          } else {
            expect(terminator).toEqual({ kind: 'flush' });
          }
        }),
        { numRuns: RUNS },
      );
    });
  });
});

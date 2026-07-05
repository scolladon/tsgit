import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ObjectId as OID } from '../../../../../src/domain/objects/object-id.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import {
  buildV2FetchRequest,
  parseV2FetchResponse,
} from '../../../../../src/domain/protocol/v2/fetch.js';
import { doneArb, havesArb, wantsArb } from '../arbitraries.js';
import { argsArb } from './arbitraries.js';

const ROUND_TRIP_RUNS = 100;
const PERMUTATION_RUNS = 100;
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

const pktBytes = (text: string): Uint8Array => {
  const total = bytesOf(text).byteLength + 4;
  return bytesOf(total.toString(16).padStart(4, '0') + text);
};

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

type OptionalSectionName = 'acknowledgments' | 'shallow-info' | 'wanted-refs';

const OID_SHALLOW = OID.from('a'.repeat(40));
const OID_WANTED = OID.from('b'.repeat(40));

/** One data-line fixture per optional section, fixed so the property isolates order, not content. */
const OPTIONAL_SECTION_LINES: Record<OptionalSectionName, ReadonlyArray<string>> = {
  acknowledgments: ['NAK\n'],
  'shallow-info': [`shallow ${OID_SHALLOW}\n`],
  'wanted-refs': [`${OID_WANTED} refs/heads/main\n`],
};

const buildFetchResponseStream = (
  sectionOrder: ReadonlyArray<OptionalSectionName>,
): AsyncIterable<PktLine> => {
  const sections: ReadonlyArray<{ name: string; lines: ReadonlyArray<Uint8Array> }> = [
    ...sectionOrder.map((name) => ({
      name,
      lines: OPTIONAL_SECTION_LINES[name].map(pktBytes),
    })),
    { name: 'packfile', lines: [pktBytes('\x01PACK-DATA')] },
  ];
  const frames = sections.map((section, index) => {
    const header = pktBytes(`${section.name}\n`);
    const boundary = index === sections.length - 1 ? FLUSH : DELIM;
    return concatBytes(header, ...section.lines, boundary);
  });
  return decodePktStream(asyncOf([concatBytes(...frames)]), { v2: true });
};

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

describe('Given an arbitrary permutation of the optional acknowledgments/shallow-info/wanted-refs sections ahead of a packfile section', () => {
  describe('When parseV2FetchResponse aggregates the sections', () => {
    it('Then acks, shallow, wanted-refs, and the pack body are the same regardless of section order', async () => {
      // Arrange
      const sut = parseV2FetchResponse;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(
            ['acknowledgments', 'shallow-info', 'wanted-refs'] as const as OptionalSectionName[],
            { minLength: 0, maxLength: 3 },
          ),
          async (sectionOrder) => {
            const stream = buildFetchResponseStream(sectionOrder);

            const result = await sut(stream);
            const packChunks = await collect(result.packBody);

            expect(result.nak).toBe(sectionOrder.includes('acknowledgments'));
            expect(result.acks).toEqual([]);
            expect(result.shallow).toEqual(
              sectionOrder.includes('shallow-info') ? [OID_SHALLOW] : [],
            );
            expect(result.unshallow).toEqual([]);
            expect(result.wantedRefs).toEqual(
              sectionOrder.includes('wanted-refs')
                ? [{ id: OID_WANTED, name: 'refs/heads/main' }]
                : [],
            );
            expect(packChunks).toEqual([bytesOf('PACK-DATA')]);
          },
        ),
        { numRuns: PERMUTATION_RUNS },
      );
    });
  });
});
